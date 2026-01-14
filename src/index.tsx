import React from 'react';
import ReactDOM from 'react-dom/client';
import ApiTester from './components/ApiTester';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <ApiTester apiUrl="http://localhost:1234" apiKey="lm-studio" />
  </React.StrictMode>
);