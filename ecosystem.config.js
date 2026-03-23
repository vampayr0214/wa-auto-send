module.exports = {
  apps: [{
    name: 'wa-auto-send',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: 'data/logs/pm2-error.log',
    out_file: 'data/logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
