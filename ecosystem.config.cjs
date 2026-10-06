"use strict";
const path = require("node:path");
const common = {
  cwd: __dirname,
  interpreter: process.execPath,
  autorestart: true,
  watch: false,
  min_uptime: "30s",
  max_restarts: 20,
  exp_backoff_restart_delay: 1000,
  kill_timeout: 120000,
  max_memory_restart: "512M",
  merge_logs: true,
  time: true,
  out_file: "/dev/stdout",
  error_file: "/dev/stderr",
  vizion: false,
  env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
};
module.exports = {
  apps: [
    {
      ...common,
      name: "gridstake-api",
      script: path.join(__dirname, "src/server.js"),
      exec_mode: "cluster",
      instances: 2,
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 50000,
      shutdown_with_message: true,
    },
    {
      ...common,
      name: "gridstake-telemetry",
      script: path.join(__dirname, "src/worker.js"),
      exec_mode: "fork",
      instances: 1,
    },
    {
      ...common,
      name: "gridstake-redemptions",
      script: path.join(__dirname, "src/redemption-worker.js"),
      exec_mode: "fork",
      instances: 1,
    },
    {
      ...common,
      name: "gridstake-discord",
      script: path.join(__dirname, "discord/bot.js"),
      exec_mode: "fork",
      instances: 1,
    },
  ],
};
