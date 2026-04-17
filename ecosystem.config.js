module.exports = {
  apps: [{
    name: 'da-platform',
    script: 'node_modules/.bin/next',
    args: 'start',
    cwd: '/var/www/da-platform',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: '/var/log/da-platform/error.log',
    out_file: '/var/log/da-platform/out.log',
  }],
};
