/** PM2: pm2 start ecosystem.config.cjs && pm2 save && pm2 startup */
module.exports = {
  apps: [
    {
      name: "fdn-bridge",
      cwd: __dirname,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/index.ts",
      interpreter: "node",
      autorestart: true,
      max_restarts: 50,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
