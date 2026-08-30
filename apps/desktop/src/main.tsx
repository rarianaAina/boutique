import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

const conteneur = document.getElementById('root');
if (!conteneur) {
  throw new Error('Élément #root introuvable');
}

createRoot(conteneur).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
