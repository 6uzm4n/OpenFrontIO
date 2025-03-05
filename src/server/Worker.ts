import express, { Request, Response, NextFunction } from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { GameManager } from "./GameManager";
import { getServerConfigFromServer } from "../core/configuration/Config";
import { WebSocket } from "ws";
import { Client } from "./Client";
import rateLimit from "express-rate-limit";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { GameConfig, GameRecord, LogSeverity } from "../core/Schemas";
import { slog } from "./StructuredLog";
import { GameType } from "../core/game/Game";
import { archive } from "./Archive";

const config = getServerConfigFromServer();

// Worker setup
export function startWorker() {
  // Get worker ID from environment variable
  const workerId = parseInt(process.env.WORKER_ID || "0");
  console.log(`Worker ${workerId} starting...`);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const gm = new GameManager(config);

  // Middleware to handle /wX path prefix
  app.use((req, res, next) => {
    // Extract the original path without the worker prefix
    const originalPath = req.url;
    const match = originalPath.match(/^\/w(\d+)(.*)$/);

    if (match) {
      const pathWorkerId = parseInt(match[1]);
      const actualPath = match[2] || "/";

      // Verify this request is for the correct worker
      if (pathWorkerId !== workerId) {
        return res.status(404).json({
          error: "Worker mismatch",
          message: `This is worker ${workerId}, but you requested worker ${pathWorkerId}`,
        });
      }

      // Update the URL to remove the worker prefix
      req.url = actualPath;
    }

    next();
  });

  app.set("trust proxy", 3);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../../out")));
  app.use(
    rateLimit({
      windowMs: 1000, // 1 second
      max: 20, // 20 requests per IP per second
    }),
  );

  const rateLimiter = new RateLimiterMemory({
    points: 50, // 50 messages
    duration: 1, // per 1 second
  });

  const updateRateLimiter = new RateLimiterMemory({
    points: 10,
    duration: 240, // 4 minutes
  });

  // Async handler with rate limiting
  const asyncHandler =
    (fn: Function, limiter = null) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (limiter) {
          if (!isLocalhost(req)) {
            const clientIP = req.ip || req.socket.remoteAddress || "unknown";
            try {
              await limiter.consume(clientIP);
            } catch (error) {
              console.warn(`Rate limited for IP ${clientIP}`);
              return res.status(429).json({ error: "Too many requests" });
            }
          }
        }
        await fn(req, res, next);
      } catch (error) {
        next(error);
      }
    };

  // Endpoint to create a private lobby
  app.post(
    "/create_game/:id",
    asyncHandler(async (req, res) => {
      const id = req.params.id;
      if (!id) {
        console.warn(`cannot create game, id not found`);
        return;
      }
      // TODO: if game is public make sure request came from localhohst!!!
      const clientIP = req.ip || req.socket.remoteAddress || "unknown";
      const gc = req.body?.gameConfig as GameConfig;
      if (gc?.gameType == GameType.Public && !isLocalhost(req)) {
        console.warn(
          `cannot create public game ${id}, ip ${clientIP} not localhost`,
        );
        return res.status(400);
      }

      // Double-check this worker should host this game
      const expectedWorkerId = config.workerIndex(id);
      if (expectedWorkerId !== workerId) {
        console.warn(
          `This game ${id} should be on worker ${expectedWorkerId}, but this is worker ${workerId}`,
        );
        return res.status(400);
      }

      const game = gm.createGame(id, gc);

      console.log(
        `Worker ${workerId}: IP ${clientIP} creating game ${game.isPublic() ? "Public" : "Private"} with id ${id}`,
      );
      res.json(game.gameInfo());
    }, updateRateLimiter),
  );

  // Add other endpoints from your original server
  app.post(
    "/start_game/:id",
    asyncHandler(async (req, res) => {
      console.log(`starting private lobby with id ${req.params.id}`);
      const game = gm.game(req.params.id);
      if (!game) {
        return;
      }
      if (game.isPublic()) {
        const clientIP = req.ip || req.socket.remoteAddress || "unknown";
        console.log(
          `cannot start public game ${game.id}, game is public, ip: ${clientIP}`,
        );
        return;
      }
      game.start();
      res.status(200).json({ success: true });
    }, updateRateLimiter),
  );

  app.put(
    "/game/:id",
    asyncHandler(async (req, res) => {
      // TODO: only update public game if from local host
      const lobbyID = req.params.id;
      if (req.body.gameType == GameType.Public) {
        console.log(`cannot update game ${lobbyID} to public`);
        return res.status(400);
      }
      const game = gm.game(lobbyID);
      if (!game) {
        return res.status(400);
      }
      if (game.isPublic()) {
        const clientIP = req.ip || req.socket.remoteAddress || "unknown";
        console.warn(`cannot update public game ${game.id}, ip: ${clientIP}`);
        return res.status(400);
      }
      game.updateGameConfig({
        gameMap: req.body.gameMap,
        difficulty: req.body.difficulty,
        infiniteGold: req.body.infiniteGold,
        infiniteTroops: req.body.infiniteTroops,
        instantBuild: req.body.instantBuild,
        bots: req.body.bots,
        disableNPCs: req.body.disableNPCs,
      });
      res.status(200).json({ success: true });
    }),
  );

  app.get(
    "/game/:id/exists",
    asyncHandler(async (req, res) => {
      const lobbyId = req.params.id;
      res.json({
        exists: gm.game(lobbyId) != null,
      });
    }),
  );

  app.get(
    "/game/:id",
    asyncHandler(async (req, res) => {
      const game = gm.game(req.params.id);
      if (game == null) {
        console.log(`lobby ${req.params.id} not found`);
        return res.status(404).json({ error: "Game not found" });
      }
      res.json(game.gameInfo());
    }),
  );

  app.post(
    "/archive_singleplayer_game",
    asyncHandler(async (req, res) => {
      const gameRecord: GameRecord = req.body;
      const clientIP = req.ip || req.socket.remoteAddress || "unknown";

      if (!gameRecord) {
        console.log("game record not found in request");
        res.status(404).json({ error: "Game record not found" });
        return;
      }
      gameRecord.players.forEach((p) => (p.ip = clientIP));
      archive(gameRecord);
      res.json({
        success: true,
      });
    }, updateRateLimiter),
  );

  // WebSocket handling
  wss.on("connection", (ws: WebSocket, req) => {
    ws.on("message", async (message: string) => {
      const forwarded = req.headers["x-forwarded-for"];
      const ip = Array.isArray(forwarded)
        ? forwarded[0]
        : forwarded || req.socket.remoteAddress;
      try {
        await rateLimiter.consume(ip);
      } catch (error) {
        console.warn(`rate limit exceeded for ${ip}`);
        return;
      }

      try {
        // Process WebSocket messages as in your original code
        // Parse and handle client messages
        const clientMsg = JSON.parse(message.toString());

        if (clientMsg.type == "join") {
          // Verify this worker should handle this game
          const expectedWorkerId = config.workerIndex(clientMsg.gameID);
          if (expectedWorkerId !== workerId) {
            console.warn(
              `Worker mismatch: Game ${clientMsg.gameID} should be on worker ${expectedWorkerId}, but this is worker ${workerId}`,
            );
            return;
          }

          // Create client and add to game
          const client = new Client(
            clientMsg.clientID,
            clientMsg.persistentID,
            ip,
            clientMsg.username,
            ws,
          );

          const wasFound = gm.addClient(
            client,
            clientMsg.gameID,
            clientMsg.lastTurn,
          );

          if (!wasFound) {
            console.log(
              `game ${clientMsg.gameID} not found on worker ${workerId}`,
            );
            // Handle game not found case
          }
        }

        // Handle other message types
      } catch (error) {
        console.warn(
          `error handling websocket message for ${ip}: ${error}`.substring(
            0,
            250,
          ),
        );
      }
    });

    ws.on("error", (error: Error) => {
      if ((error as any).code === "WS_ERR_UNEXPECTED_RSV_1") {
        ws.close(1002);
      }
    });
  });

  // Set up ticker
  setInterval(() => gm.tick(), 1000);

  // The load balancer will handle routing to this server based on path
  const PORT = config.workerPortByIndex(workerId);
  server.listen(PORT, () => {
    console.log(`Worker ${workerId} running on http://localhost:${PORT}`);
    console.log(`Handling requests with path prefix /w${workerId}/`);
    // Signal to the master process that this worker is ready
    if (process.send) {
      process.send({
        type: "WORKER_READY",
        workerId: workerId,
      });
      console.log(`Worker ${workerId} signaled ready state to master`);
    }
  });

  // Global error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(`Error in ${req.method} ${req.path}:`, err);
    slog({
      logKey: "server_error",
      msg: `Unhandled exception in ${req.method} ${req.path}: ${err.message}`,
      severity: LogSeverity.Error,
      stack: err.stack,
    });
    res.status(500).json({ error: "An unexpected error occurred" });
  });

  // Process-level error handlers
  process.on("uncaughtException", (err) => {
    console.error(`Worker ${workerId} uncaught exception:`, err);
    slog({
      logKey: "uncaught_exception",
      msg: `Worker ${workerId} uncaught exception: ${err.message}`,
      severity: LogSeverity.Error,
      stack: err.stack,
    });
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error(
      `Worker ${workerId} unhandled rejection at:`,
      promise,
      "reason:",
      reason,
    );
    slog({
      logKey: "unhandled_rejection",
      msg: `Worker ${workerId} unhandled promise rejection: ${reason}`,
      severity: LogSeverity.Error,
    });
  });
}

const isLocalhost = (req: Request): boolean => {
  // Get client IP address from various possible sources
  const clientIP =
    req.ip ||
    req.socket.remoteAddress ||
    (req.headers["x-forwarded-for"] as string)?.split(",").shift() ||
    "unknown";

  // Check if the request is from a loopback address
  const isLoopbackIP =
    // IPv4 localhost
    clientIP === "127.0.0.1" ||
    // IPv6 localhost
    clientIP === "::1" ||
    // Full loopback range
    clientIP.startsWith("127.");

  // Check hostname
  const isLocalHostname =
    req.hostname === "localhost" || req.headers.host?.startsWith("localhost:");

  // Consider request local if either IP is loopback or hostname is localhost
  return isLoopbackIP || isLocalHostname;
};
