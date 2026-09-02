/* global process */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envValue = (...names) => {
  const value = names
    .map((name) => process.env[name])
    .find((candidate) => candidate != null);
  return value == null ? 'undefined' : JSON.stringify(value);
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'privatepoker-hooks': path.resolve(__dirname, './src'),
      '@': path.resolve(__dirname, './src'),
      'next/navigation': path.resolve(__dirname, './src/shims/next-navigation.js'),
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.js'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [
        '@reown/appkit/react',
        'react',
        'react-router-dom',
        'viem',
        'viem/accounts',
        'viem/chains',
        'wagmi',
      ],
    },
  },
  define: {
    'process.env.NEXT_PUBLIC_PRIVATE_POKER_CHAIN': envValue(
      'NEXT_PUBLIC_PRIVATE_POKER_CHAIN',
      'PUBLIC_PRIVATE_POKER_CHAIN',
      'VITE_PRIVATE_POKER_CHAIN',
    ),
    'process.env.NEXT_PUBLIC_PRIVATE_POKER_MESH': envValue(
      'NEXT_PUBLIC_PRIVATE_POKER_MESH',
      'PUBLIC_PRIVATE_POKER_MESH',
      'VITE_PRIVATE_POKER_MESH',
    ),
    'process.env.PUBLIC_PRIVATE_POKER_MESH': envValue(
      'PUBLIC_PRIVATE_POKER_MESH',
      'NEXT_PUBLIC_PRIVATE_POKER_MESH',
      'VITE_PRIVATE_POKER_MESH',
    ),
    'process.env.VITE_PRIVATE_POKER_MESH': envValue(
      'VITE_PRIVATE_POKER_MESH',
      'NEXT_PUBLIC_PRIVATE_POKER_MESH',
      'PUBLIC_PRIVATE_POKER_MESH',
    ),
    'process.env.NEXT_PUBLIC_PRIVATE_MESH_ENDPOINTS': envValue(
      'NEXT_PUBLIC_PRIVATE_MESH_ENDPOINTS',
      'PUBLIC_PRIVATE_MESH_ENDPOINTS',
      'VITE_PRIVATE_MESH_ENDPOINTS',
    ),
    'process.env.PUBLIC_PRIVATE_MESH_ENDPOINTS': envValue(
      'PUBLIC_PRIVATE_MESH_ENDPOINTS',
      'NEXT_PUBLIC_PRIVATE_MESH_ENDPOINTS',
      'VITE_PRIVATE_MESH_ENDPOINTS',
    ),
    'process.env.VITE_PRIVATE_MESH_ENDPOINTS': envValue(
      'VITE_PRIVATE_MESH_ENDPOINTS',
      'NEXT_PUBLIC_PRIVATE_MESH_ENDPOINTS',
      'PUBLIC_PRIVATE_MESH_ENDPOINTS',
    ),
  },
});
