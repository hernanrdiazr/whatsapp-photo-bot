module.exports = {
  apps: [
    {
      name: "bot-whatsapp",
      script: "tsx",
      args: "index.ts",
      watch: false,
      autorestart: true,
      max_memory_restart: "1000M"
    }
  ]
}