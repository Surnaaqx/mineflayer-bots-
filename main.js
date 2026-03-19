const { fork } = require('child_process')
const config = require('./config.json')

console.log(`Запуск ${config.bots.count} ботов на сервер ${config.server.host}:${config.server.port} (версия ${config.server.version})`)

for (let i = 0; i < config.bots.count; i++) {
  setTimeout(() => {
    const worker = fork('./botWorker.js')
    worker.send({
      ...config,
      workerId: i
    })
    console.log(`Запущен бот #${i}`)
  }, i * config.bots.joinDelay)
}

// Обработка завершения
process.on('SIGINT', () => {
  console.log('Завершение работы...')
  process.exit()
})
