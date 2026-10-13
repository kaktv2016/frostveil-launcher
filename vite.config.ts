import {defineConfig} from 'vite';
import tailwind from '@tailwindcss/vite';
export default defineConfig({root:'src/renderer',base:'./',plugins:[tailwind()],build:{outDir:'../../dist/renderer',emptyOutDir:false}});
