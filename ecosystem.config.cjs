const path = require("node:path");

const defaultRdsCaPath = "/etc/next-tracking/rds-ca.pem";

module.exports = {
  apps: [
    {
      name: "next-tracking-api",
      cwd: "./apps/api",
      script: "dist/server.js",
      interpreter: "node",
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
        NODE_EXTRA_CA_CERTS:
          process.env.NODE_EXTRA_CA_CERTS ?? defaultRdsCaPath,
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
    },
  ],
};
