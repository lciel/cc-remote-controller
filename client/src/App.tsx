import Router from 'preact-router';
import { ProjectList } from './components/ProjectList';
import { ProjectDetail } from './components/ProjectDetail';

export function App() {
  return (
    <div class="app">
      <Router>
        <ProjectList path="/" />
        <ProjectDetail path="/projects/:id" />
      </Router>
    </div>
  );
}
