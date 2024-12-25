"use client";

import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Plus, Rocket } from "lucide-react";
import Link from "next/link";
import { ProjectCard } from "@/components/project-card";
import { useSelector } from "react-redux";
import { RootState } from "@/app/store";
import BlurFade from "@/components/ui/blur-fade";
import BlurIn from "@/components/ui/blur-in";

export default function ProjectsPage() {
  const { user } = useSelector((state: RootState) => state.user);
  const { projects } = useSelector((state: RootState) => state.projects);

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-7xl relative top-16 mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="font-bold">
            <BlurIn
              word={`${user?.name}'s Projects`}
              className="text-4xl font-bold text-black dark:text-white"
            />
          </h1>
          <BlurFade key="BUTTON" delay={0.25 + 1 * 0.05} inView>
            <Button asChild className="bg-primary text-primary-foreground">
              <Link href="/projects/create">
                <Rocket className="h-4 w-4" />
                New Project
              </Link>
            </Button>
          </BlurFade>
        </div>

        <motion.div
          className="grid md:grid-cols-2 lg:grid-cols-3 gap-6"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {projects?.length === 0 ? (
            <motion.div
              className="flex items-center justify-center flex-col p-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5 }}
            >
              <Plus className="text-6xl text-muted-foreground mb-4" />
              <p className="text-xl mt-4 text-muted-foreground">
                No projects created yet
              </p>
            </motion.div>
          ) : (
            projects?.map((project, idx) => (
              <BlurFade key={idx} delay={0.25 + idx * 0.05} inView>
                <ProjectCard key={project.id} project={project} />
              </BlurFade>
            ))
          )}
        </motion.div>
      </div>
    </div>
  );
}
