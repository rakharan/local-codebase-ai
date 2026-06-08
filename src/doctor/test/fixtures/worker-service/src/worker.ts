import amqp from 'amqplib';

const RABBIT_URL = process.env.RABBIT_URL || 'amqp://localhost';

async function start() {
  const conn = await amqp.connect(RABBIT_URL);
  const channel = await conn.createChannel();

  channel.assertQueue('task-queue', { durable: true });
  channel.assertExchange('events', 'topic', { durable: true });
  channel.consume('task-queue', (msg) => {
    console.log('Processing:', msg?.content.toString());
  });
  channel.publish('events', 'task.completed', Buffer.from('done'));
}

start();
