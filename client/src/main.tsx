import { render } from 'preact';
import { App } from './App';
import './styles/global.css';

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

render(<App />, document.getElementById('app')!);
