// Importing this module also fails the browser build (see vite.config.ts).
if (typeof window !== 'undefined') throw new Error('Server-only module loaded in a browser.');
