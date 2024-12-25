"use client";

import withAuthRequired from "@/utils/withAuthRequired";
import Projects from "@/components/pages/ProjectsPage";

function ProjectsPageWrapper() {
  return <Projects />;
}

export default withAuthRequired(ProjectsPageWrapper);