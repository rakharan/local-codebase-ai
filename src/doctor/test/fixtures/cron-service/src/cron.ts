import cron from 'node-cron';

const DB_URL = process.env.DB_URL;

cron.schedule('0 * * * *', async () => {
  const q = "DELETE FROM expired_sessions WHERE created_at < NOW()";
  const q2 = "UPDATE stats SET last_run = NOW() WHERE job = 'cleanup'";
  console.log('Cron job executed');
});
