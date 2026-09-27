import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './i18n';
import App from './App';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { refetchInterval: 5000 } } })}
    >
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
