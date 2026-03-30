import { render } from 'preact';
import { App } from './App';
import './styles/global.css';

// Detect auth token from URL query parameter (e.g., from QR code scan)
const urlParams = new URLSearchParams(window.location.search);
const urlToken = urlParams.get('token');
if (urlToken) {
  localStorage.setItem('cc-auth-token', urlToken);
  urlParams.delete('token');
  const cleanSearch = urlParams.toString();
  const cleanUrl = window.location.pathname + (cleanSearch ? `?${cleanSearch}` : '');
  history.replaceState(null, '', cleanUrl);
}

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

render(<App />, document.getElementById('app')!);
