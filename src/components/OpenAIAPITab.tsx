import React, { useState, useEffect } from 'react';
import ApiTester from './ApiTester';

const OpenAIAPITab: React.FC = () => {
  return (
    <div className="p-6">
      <div className="bg-white rounded-lg shadow-md p-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">OpenAI Compatible API Tester</h2>
        <ApiTester apiUrl="http://localhost:1234" apiKey="lm-studio" />
      </div>
    </div>
  );
};

export default OpenAIAPITab;