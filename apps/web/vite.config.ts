import {defineConfig, loadEnv} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, resolve(__dirname, '../..'), '');
  const apiPort = env.API_PORT || '3001';
  return {
    root: __dirname,
    plugins: [react()],
    server: {port: Number(env.WEB_PORT || 5173), proxy: {'/api': `http://localhost:${apiPort}`, '/health': `http://localhost:${apiPort}`}},
  };
});
