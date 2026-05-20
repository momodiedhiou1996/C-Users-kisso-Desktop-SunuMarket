module.exports = {
  apps: [
    {
      name: "sunumarket-api",
      script: "server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "350M",
      env: {
        NODE_ENV: "production",
        PORT: 4001,
        TRUST_PROXY: "true",
      },
    },
  ],
};
