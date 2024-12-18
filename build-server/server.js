const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const mime = require("mime-types");
const dotenv = require("dotenv");
const { Kafka, Partitioners } = require("kafkajs");
const { createClient } = require("@clickhouse/client");
const { randomUUID } = require("crypto");

// Load AWS credentials from .env file
const envPath = path.resolve(process.cwd(), ".env");
const envConfig = dotenv.config({ path: envPath }).parsed || {};

// Create S3 client with credentials from .env file
const s3Client = new S3Client({
  region: envConfig.AWS_REGION,
  credentials: {
    accessKeyId: envConfig.AWS_ACCESS_KEY_ID,
    secretAccessKey: envConfig.AWS_SECRET_ACCESS_KEY,
  },
});

// Get project-related variables from process.env (Docker/ECS environment)
const PROJECT_ID = process.env.PROJECT_ID;
const DEPLOYEMENT_ID = process.env.DEPLOYEMENT_ID;
const PROJECT_INSTALL_COMMAND = process.env.PROJECT_INSTALL_COMMAND;
const PROJECT_BUILD_COMMAND = process.env.PROJECT_BUILD_COMMAND;
const PROJECT_ROOT_DIR = process.env.PROJECT_ROOT_DIR;
const S3_BUCKET_NAME = envConfig.S3_BUCKET_NAME;

// Kafka Client
const kafka = new Kafka({
  clientId: envConfig.KAFKA_CLIENT_ID,
  brokers: [envConfig.KAFKA_BROKER],
  ssl: {
    ca: [fs.readFileSync(path.join(__dirname, "ca.pem"), "utf-8")],
  },
  sasl: {
    username: envConfig.SASL_USERNAME,
    password: envConfig.SASL_PASSWORD,
    mechanism: envConfig.SASL_MECHANISM,
  },
});

// Clickhouse Client
const client = createClient({
  database: envConfig.CLICKHOUSE_DB,
  url: envConfig.CLICKHOUSE_HOST,
});

const producer = kafka.producer({
  createPartitioner: Partitioners.LegacyPartitioner,
});

const consumer = kafka.consumer({ groupId: "build-logs-consumer" });

async function publishLog(log) {
  try {
    // Ensure the producer is connected before sending
    await producer.connect();

    await producer.send({
      topic: `build-logs`,
      messages: [
        {
          key: "log",
          value: JSON.stringify({ PROJECT_ID, DEPLOYEMENT_ID, log }),
        },
      ],
    });
  } catch (error) {
    console.error("Error publishing log:", error);
  }
}

async function InitializeScript() {
  try {
    console.log("Executing script...");
    await publishLog("Executing script...");
    const outputDir = path.join(__dirname, "output");

    // Filter out PROJECT_ENVIRONMENT_ variables from process.env
    const projectEnvVars = Object.keys(process.env)
      .filter((key) => key.startsWith("PROJECT_ENVIRONMENT_"))
      .reduce((envVars, key) => {
        envVars[key] = process.env[key];
        return envVars;
      }, {});

    return new Promise((resolve, reject) => {
      const buildProcess = exec(
        `cd ${outputDir} && ${PROJECT_INSTALL_COMMAND} && ${PROJECT_BUILD_COMMAND}`,
        {
          cwd: PROJECT_ROOT_DIR,
          env: {
            ...process.env,
            ...projectEnvVars,
          },
        }
      );

      buildProcess.stdout.on("data", async (data) => {
        console.log(data.toString());
        await publishLog(data.toString());
      });

      buildProcess.stderr.on("data", async (data) => {
        console.error("Error:", data.toString());
        await publishLog(data.toString());
      });

      buildProcess.on("close", async (code) => {
        try {
          console.log(`Build complete with code ${code}`);
          await publishLog(`Build complete with code ${code}`);

          const distDir = path.join(outputDir, "dist");
          const distFiles = fs.readdirSync(distDir, { recursive: true });

          for (const file of distFiles) {
            const filePath = path.join(distDir, file);
            if (fs.lstatSync(filePath).isDirectory()) continue;

            console.log(`Uploading ${filePath}...`);
            await publishLog(`Uploading ${filePath}...`);

            const command = new PutObjectCommand({
              Bucket: S3_BUCKET_NAME,
              Key: `__outputs/${PROJECT_ID}/${file}`,
              Body: fs.createReadStream(filePath),
              ContentType: mime.lookup(filePath),
            });

            await s3Client.send(command);
          }

          console.log("Upload complete...");
          await publishLog("Upload complete...");

          resolve();
          process.exit(0);
        } catch (error) {
          console.error("Error in build process close handler:", error);
          reject(error);
          process.exit(1);
        }
      });

      buildProcess.on("error", (error) => {
        console.error("Execution error:", error);
        reject(error);
      });
    });
  } catch (error) {
    console.error("Error in InitializeScript:", error);
    throw error;
  }
}

const initializeKafkaConsumer = async () => {
  try {
    const event_id = randomUUID();
    await consumer.connect();
    await consumer.subscribe({ topic: "build-logs" });

    let isUploadComplete = false;

    await consumer.run({
      eachBatch: async function ({
        batch,
        heartbeat,
        commitOffsetsIfNecessary,
      }) {
        const messages = batch.messages;
        console.log(`Recv. ${messages.length} messages..`);

        for (const message of messages) {
          if (!message.value) continue;

          const stringMessage = message.value.toString();
          const { DEPLOYEMENT_ID, log } = JSON.parse(stringMessage);
          console.log({ log, DEPLOYEMENT_ID });

          // Check if upload is complete
          if (log.includes("Upload complete")) {
            isUploadComplete = true;
          }

          try {
            const { query_id } = await client.insert({
              table: "log_events",
              values: [
                {
                  event_id,
                  deployment_id: DEPLOYEMENT_ID,
                  log,
                },
              ],
              format: "JSONEachRow",
            });

            console.log(query_id);

            // Commit the offset for this specific message
            await commitOffsetsIfNecessary({
              topics: [
                {
                  topic: "build-logs",
                  partitions: [
                    {
                      partition: batch.partition,
                      offset: message.offset,
                    },
                  ],
                },
              ],
            });

            await heartbeat();
          } catch (err) {
            console.log(err);
          }
        }

        // Exit process if upload is complete
        if (isUploadComplete) {
          console.log("Upload complete. Exiting process...");
          await consumer.disconnect();
          process.exit(0);
        }
      },
      // Add a timeout to exit if no upload complete message is received
      autoCommit: false,
      eachBatchAutoResolve: true,
    });

    // Add a timeout to exit if process hangs
    setTimeout(() => {
      console.log("Timeout reached. Exiting process...");
      process.exit(1);
    }, 30 * 60 * 1000); // 30 minutes timeout
  } catch (error) {
    console.error("Failed to initialize Kafka consumer:", error);
    process.exit(1);
  }
};

InitializeScript();
initializeKafkaConsumer();
