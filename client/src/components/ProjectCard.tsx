import { Project } from '../api/rest';

const stateColors: Record<string, string> = {
  IDLE: 'var(--color-success)',
  RUNNING: 'var(--color-warning)',
  STOPPING: 'var(--color-warning)',
  ERROR: 'var(--color-error)',
};

interface Props {
  project: Project;
  editing?: boolean;
  onDelete?: (id: string) => void;
}

export function ProjectCard({ project, editing, onDelete }: Props) {
  const updatedAt = new Date(project.updated_at).toLocaleString();

  const handleDelete = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`Delete "${project.name}"?`)) {
      onDelete?.(project.id);
    }
  };

  return (
    <a href={`/projects/${project.id}`} class="project-card">
      {editing && (
        <button class="card-remove-btn" onClick={handleDelete}>x</button>
      )}
      <div class="project-card-body">
        <div class="project-card-info">
          <span class="project-name">{project.name}</span>
          <div class="project-repo">{project.repo_path}</div>
          <div class="project-updated">Updated: {updatedAt}</div>
        </div>
        <span
          class="state-badge"
          style={{ backgroundColor: stateColors[project.state] || 'gray' }}
        >
          {project.state}
        </span>
      </div>
    </a>
  );
}
