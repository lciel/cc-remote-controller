import { Project } from '../api/rest';

const stateColors: Record<string, string> = {
  IDLE: 'var(--color-success)',
  RUNNING: 'var(--color-warning)',
  STOPPING: 'var(--color-warning)',
  ERROR: 'var(--color-error)',
};

interface Props {
  project: Project;
}

export function ProjectCard({ project }: Props) {
  return (
    <a href={`/projects/${project.id}`} class="project-card">
      <div class="project-card-body">
        <div class="project-card-info">
          <div class="project-card-header">
            <span class="project-name">{project.name}</span>
            {project.state !== 'IDLE' && (
              <span class="project-state-inline" style={{ backgroundColor: stateColors[project.state] || 'gray' }}>
                {project.state}
              </span>
            )}
          </div>
          <div class="project-repo">{project.repo_path}</div>
        </div>
        <span class="project-card-chevron">›</span>
      </div>
    </a>
  );
}
