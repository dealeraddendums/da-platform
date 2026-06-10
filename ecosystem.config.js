// da-platform — pm2 cluster config for zero-downtime `pm2 reload`.
// Lives at /var/www/da-platform/ecosystem.config.js (a STABLE path, outside releases).
// cwd is the `current` symlink, so each `pm2 reload` re-spawns workers into the new release.
// Spec: docs/zero-downtime-deploy.md
module.exports = {
  apps: [{
    name: 'da-platform',
    script: 'node_modules/next/dist/bin/next', // direct path — never the flaky .bin/next symlink
    args: 'start',
    cwd: '/var/www/da-platform/current',
    exec_mode: 'cluster',
    instances: 2,                              // >=2 so `reload` always leaves a live worker
    autorestart: true,
    watch: false,
    max_memory_restart: '768M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: '/var/log/da-platform/error.log',
    out_file: '/var/log/da-platform/out.log',
  }],
};
