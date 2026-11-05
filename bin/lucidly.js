#!/usr/bin/env node
// Entry point. In a checkout, Node (>= 22.18) runs the TypeScript sources directly. Installed
// from npm it can't (Node won't strip types under node_modules), so it runs the compiled dist/.
const installed = import.meta.url.includes('/node_modules/');
await import(installed ? '../dist/cli.js' : '../src/cli.ts');
