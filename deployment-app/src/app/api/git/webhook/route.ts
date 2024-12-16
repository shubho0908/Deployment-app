import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchGitLatestCommit } from "@/utils/github";

// Verify GitHub webhook signature
function verifyGitHubWebhook(req: NextRequest, payload: string): boolean {
  const githubSignatureHeader = req.headers.get("x-hub-signature-256");

  if (!githubSignatureHeader) {
    console.error("No GitHub signature header found");
    return false;
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error("GitHub webhook secret is not set");
    return false;
  }

  const hmac = crypto.createHmac("sha256", secret);
  const digest = `sha256=${hmac.update(payload).digest("hex")}`;

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(githubSignatureHeader)
  );
}

export async function POST(req: NextRequest) {
  try {
    const payload = await req.text();
    const projectId = req.nextUrl.searchParams.get("projectId");

    // Verify webhook signature
    if (!verifyGitHubWebhook(req, payload)) {
      return NextResponse.json({ status: 403, message: "Unauthorized" });
    }
    const body = JSON.parse(payload);

    if (body.event !== "push") {
      return NextResponse.json({ status: 200, message: "Not a push event" });
    }

    // Extract repository and branch information
    const repoUrl = body.repository.clone_url;
    const branchName = body.ref.replace("refs/heads/", "");
    const commitHash = body.after;

    // Get the project ID from request params

    // Find the specific project matching the repo URL and project ID
    const project = await prisma.project.findUnique({
      where: {
        id: projectId!,
        gitRepoUrl: repoUrl,
      },
      include: {
        deployments: {
          include: {
            project: true,
          },
        },
      },
    });

    if (!project) {
      return NextResponse.json({
        status: 200,
        message: "No matching project found for the push event",
      });
    }

    // Fetch the latest commit to ensure we're using the most recent information
    await fetchGitLatestCommit({
      repoUrl,
      branch: branchName,
    });

    // Prepare deployment payload
    const deploymentPayload = {
      projectId: project.id,
      gitBranchName: branchName,
      gitRepoUrl: repoUrl,
      gitCommitHash: commitHash,
      buildCommand: project?.buildCommand || "npm run build",
      installCommand: project?.installCommand || "npm install",
      projectRootDir: project?.projectRootDir || "./",
      environmentVariables:
        project.deployments[0]?.environmentVariables || {},
    };

    // Send deployment request to your existing deployment endpoint
    // TODO: Update with axios
    const deployResponse = await fetch("/api/deploy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(deploymentPayload),
    });

    const deployResult = await deployResponse.json();

    // Log deployment result
    console.log(
      `Deployment triggered for project ${project.id}:`,
      deployResult
    );

    return NextResponse.json({
      status: 200,
      message: "Webhook processed successfully",
      projectsDeployed: 1,
    });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return NextResponse.json({
      status: 500,
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
