import { extractRabbitMq } from '../extractors/rabbitmq-extractor.js';

function runTests(): void {
  console.log('Running RabbitMQ extractor tests...');

  testAssertQueue();
  testAssertExchange();
  testPublish();
  testSendToQueue();
  testConsume();
  testSubscribe();
  testRpcSend();
  testQueueConfigObject();
  testDeduplication();
  testLineNumbers();
  testEmptyContent();
  testMultiplePatterns();

  console.log('✅ All RabbitMQ extractor tests passed!');
}

function testAssertQueue(): void {
  console.log('Test: assertQueue');
  const facts = extractRabbitMq(`channel.assertQueue('payment-queue', { durable: true });`, 'src/mq.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'payment-queue', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.messageType === 'queue', `Type: ${facts[0]!.messageType}`);
  assert(facts[0]!.operation === 'assert', `Op: ${facts[0]!.operation}`);
  assert(facts[0]!.confidence === 'high', `Confidence: ${facts[0]!.confidence}`);
  console.log('  ✓ passed');
}

function testAssertExchange(): void {
  console.log('Test: assertExchange');
  const facts = extractRabbitMq(`channel.assertExchange('events', 'topic', {});`, 'src/mq.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'events', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.messageType === 'exchange', `Type: ${facts[0]!.messageType}`);
  assert(facts[0]!.operation === 'assert', `Op: ${facts[0]!.operation}`);
  console.log('  ✓ passed');
}

function testPublish(): void {
  console.log('Test: publish');
  const facts = extractRabbitMq(`channel.publish('events', 'order.created', Buffer.from(msg));`, 'src/pub.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'order.created', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.messageType === 'routing_key', `Type: ${facts[0]!.messageType}`);
  assert(facts[0]!.operation === 'publish', `Op: ${facts[0]!.operation}`);
  console.log('  ✓ passed');
}

function testSendToQueue(): void {
  console.log('Test: sendToQueue');
  const facts = extractRabbitMq(`channel.sendToQueue('task-queue', Buffer.from(data));`, 'src/sender.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'task-queue', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.messageType === 'queue', `Type: ${facts[0]!.messageType}`);
  assert(facts[0]!.operation === 'send', `Op: ${facts[0]!.operation}`);
  console.log('  ✓ passed');
}

function testConsume(): void {
  console.log('Test: consume');
  const facts = extractRabbitMq(`channel.consume('payment-queue', handler);`, 'src/con.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'payment-queue', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.operation === 'consume', `Op: ${facts[0]!.operation}`);
  console.log('  ✓ passed');
}

function testSubscribe(): void {
  console.log('Test: subscribe');
  const facts = extractRabbitMq(`this.subscribe('notification-queue', handler);`, 'src/sub.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'notification-queue', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.operation === 'consume', `Op: ${facts[0]!.operation}`);
  assert(facts[0]!.confidence === 'medium', `Confidence: ${facts[0]!.confidence}`);
  console.log('  ✓ passed');
}

function testRpcSend(): void {
  console.log('Test: rpcClient.send');
  const facts = extractRabbitMq(`rpcClient.send('getUserBalance', { userId });`, 'src/rpc.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'getUserBalance', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.messageType === 'rpc', `Type: ${facts[0]!.messageType}`);
  assert(facts[0]!.operation === 'send', `Op: ${facts[0]!.operation}`);
  assert(facts[0]!.confidence === 'medium', `Confidence: ${facts[0]!.confidence}`);
  console.log('  ✓ passed');
}

function testLineNumbers(): void {
  console.log('Test: line numbers');
  const content = `// line 1\n// line 2\nchannel.assertQueue('q1', {});\n// line 4\nchannel.consume('q1', h);`;
  const facts = extractRabbitMq(content, 'src/mq.ts');
  assert(facts[0]!.line === 3, `Expected line 3, got ${facts[0]!.line}`);
  assert(facts[1]!.line === 5, `Expected line 5, got ${facts[1]!.line}`);
  console.log('  ✓ passed');
}

function testQueueConfigObject(): void {
  console.log('Test: queue in config object (getInstance pattern)');
  const content = `const tfConsumer = amqp.getInstance({\n    hostname: process.env.AMQP_HOST,\n    queue: "con-tf2-ois"\n});`;
  const facts = extractRabbitMq(content, 'rpc/consumer.js');
  const queueFact = facts.find(f => f.name === 'con-tf2-ois');
  assert(queueFact !== undefined, 'Should detect queue in config object');
  assert(queueFact!.messageType === 'queue', `Type: ${queueFact!.messageType}`);
  assert(queueFact!.confidence === 'medium', `Confidence: ${queueFact!.confidence}`);

  // Multiple queues in rpcClient config
  const content2 = `const mrgRpc = rpcClient.getInstance({ queue: "rpc-tf2-com-mrg" });\nconst askapRpc = rpcClient.getInstance({ queue: "rpc-tf2-com-askap" });`;
  const facts2 = extractRabbitMq(content2, 'rpc/request.js');
  assert(facts2.length === 2, `Expected 2, got ${facts2.length}`);
  assert(facts2[0]!.name === 'rpc-tf2-com-mrg', `Name: ${facts2[0]!.name}`);
  assert(facts2[1]!.name === 'rpc-tf2-com-askap', `Name: ${facts2[1]!.name}`);
  console.log('  ✓ passed');
}

function testDeduplication(): void {
  console.log('Test: deduplication');
  // assertQueue and queue: config on same line with same queue name should dedupe
  const content = `channel.assertQueue('my-queue', { queue: "my-queue" });`;
  const facts = extractRabbitMq(content, 'src/mq.ts');
  // assertQueue produces assert, queue: produces assert — same name+operation+line = deduped
  const myQueueFacts = facts.filter(f => f.name === 'my-queue');
  assert(myQueueFacts.length === 1, `Expected 1 (deduped), got ${myQueueFacts.length}`);
  console.log('  ✓ passed');
}

function testEmptyContent(): void {
  console.log('Test: empty content');
  assert(extractRabbitMq('', 'src/x.ts').length === 0, 'Empty should produce 0');
  assert(extractRabbitMq('const x = 42;', 'src/x.ts').length === 0, 'No MQ should produce 0');
  console.log('  ✓ passed');
}

function testMultiplePatterns(): void {
  console.log('Test: multiple patterns');
  const content = `channel.assertQueue('q1', {});\nchannel.assertExchange('ex1', 'topic', {});\nchannel.publish('ex1', 'key1', buf);\nchannel.sendToQueue('q1', buf);\nchannel.consume('q1', h);`;
  const facts = extractRabbitMq(content, 'src/full.ts');
  assert(facts.length === 5, `Expected 5, got ${facts.length}`);
  console.log('  ✓ passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export { runTests };
