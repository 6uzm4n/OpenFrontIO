import {PlayerInfo} from "../Game";
import {DefaultConfig} from "./DefaultConfig";

export const devConfig = new class extends DefaultConfig {
    numSpawnPhaseTurns(): number {
        return 60
    }
    gameCreationRate(): number {
        return 3 * 1000
    }
    lobbyLifetime(): number {
        return 3 * 1000
    }
    turnIntervalMs(): number {
        return 100
    }

    numBots(): number {
        return 250
    }

    startTroops(playerInfo: PlayerInfo): number {
        if (playerInfo.isBot) {
            return 5000
        }
        return 5000
    }
}