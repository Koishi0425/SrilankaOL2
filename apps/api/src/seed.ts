import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';

import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';

const config = loadServiceConfig();
if (config.nodeEnv === 'production') {
  throw new Error('Development seed is disabled in production');
}

const email = process.env.SEED_HOST_EMAIL;
const password = process.env.SEED_HOST_PASSWORD;
if (!email || !password) {
  throw new Error('SEED_HOST_EMAIL and SEED_HOST_PASSWORD are required');
}

const database = createDatabasePool(config.databaseUrl);
try {
  const auth = new AuthService(database);
  const user = await auth.createDevelopmentUser({
    email,
    password,
    displayName: process.env.SEED_HOST_NAME ?? '主持人',
    systemRole: 'User',
  });
  process.stdout.write(`Development host ready: ${user.email}\n`);

  const games = new GameService(database);
  const accessibleGames = await games.listForUser(user.id);
  if (accessibleGames.length === 0) {
    const countryNames = (process.env.SEED_COUNTRY_NAMES ?? '')
      .split(/[，,]/)
      .map((name) => name.trim())
      .filter(Boolean);
    const game = await games.create({
      userId: user.id,
      name: process.env.SEED_GAME_NAME?.trim() || 'Srilanka Campaign',
      countryNames,
    });
    process.stdout.write(`Development game ready: ${game.name}\n`);
  }
} finally {
  await database.end();
}
