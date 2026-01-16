import React from 'react';
import ApiTester from './ApiTester';

const OpenAIAPITab: React.FC = () => {
  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        <ApiTester apiUrl="http://localhost:1234" apiKey="lm-studio" />
      </div>
    </div>
  );
};

export default OpenAIAPITab;
