import 'dotenv/config';
import { Template, defaultBuildLogger } from 'e2b';

export const template = Template()
  .fromNodeImage('21')
  .runCmd('sudo apt-get update && sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2')
  .setWorkdir('/home/user/remotion-app')
  .copy('./prebuilt-app', '/home/user/remotion-app')
  .runCmd('npm install')
  .runCmd('chmod -R 777 node_modules/.bin')
  .runCmd('npx remotion browser ensure')
  .setWorkdir('/home/user/remotion-app');

await Template.build(template, 'remotion-renderer-v2', {
  cpuCount: 4,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
});
