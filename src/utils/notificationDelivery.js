const prisma = require('../lib/prisma');

const SUPPORTED_CHANNELS = new Set(['EMAIL', 'SMS', 'PUSH', 'IN_APP']);

const createDelivery = (data) => {
  if (!SUPPORTED_CHANNELS.has(data.channel)) throw new Error(`Unsupported notification channel: ${data.channel}`);
  return prisma.notificationDelivery.create({ data });
};

module.exports = { SUPPORTED_CHANNELS, createDelivery };
