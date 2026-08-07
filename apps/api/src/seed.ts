import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';

import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { WorldService } from './modules/world/world-service.js';

const config = loadServiceConfig();
if (config.nodeEnv === 'production') {
  throw new Error('Development seed is disabled in production');
}

const username = process.env.SEED_HOST_USERNAME;
const password = process.env.SEED_HOST_PASSWORD;
if (!username || !password) {
  throw new Error('SEED_HOST_USERNAME and SEED_HOST_PASSWORD are required');
}

const database = createDatabasePool(config.databaseUrl);
try {
  const auth = new AuthService(database);
  const user = await auth.createDevelopmentUser({
    username,
    password,
    displayName: process.env.SEED_HOST_NAME ?? '主持人',
    systemRole: 'User',
  });
  process.stdout.write(`Development host ready: ${user.username}\n`);

  const games = new GameService(database);
  const accessibleGames = await games.listForUser(user.id);
  let game = accessibleGames[0];
  if (!game) {
    const countryNames = (process.env.SEED_COUNTRY_NAMES ?? '')
      .split(/[，,]/)
      .map((name) => name.trim())
      .filter(Boolean);
    game = await games.create({
      userId: user.id,
      name: process.env.SEED_GAME_NAME?.trim() || 'Srilanka Campaign',
      countryNames,
    });
    process.stdout.write(`Development game ready: ${game.name}\n`);
  }
  const world = new WorldService(database);
  const map = await world.initializeDevelopmentMap(game.id, user.id);
  process.stdout.write(`Development map ready: ${map.name}\n`);
} finally {
  await database.end();
}
