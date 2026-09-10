const fs = require('node:fs');
const stopFile = process.argv[2];
if (!stopFile) throw new Error('An owned stop-file path is required.');
// Do not depend on stdin remaining connected on a CI worker.
setInterval(() => {
  if (fs.existsSync(stopFile)) process.exit(0);
}, 100);
setTimeout(() => {
  console.error('Owned Hub fixture timed out.');
  process.exit(2);
}, 10 * 60 * 1000);
console.log('ready');
