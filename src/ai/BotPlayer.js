"use strict";
const PlayerTracker = require("../PlayerTracker");
const Vector = require("../modules/Vec2");

class BotPlayer extends PlayerTracker {
    constructor(gameServer, socket) {
        super(gameServer, socket);
        this.isBot = true;
        this.bulletsFed = 0;
        this.teamingWith = null;
        this.lastAction = Date.now();
        this.assistMode = "combat";
        this.baseFollowRadius = 250;
        this.combatMemory = new Map();
        this.feedInterval = 0.1;
        this.threatResponseDelay = 1000;
        this.lastVirusSplit = 0;
        this.combatCooldown = 0;
        this.minFeedMass = 300;
        this.originalColor = this.color;
        this.splitCooldown = 0;
        this.targetPursuit = 0;
        this.splitTarget = null;
        this.isTargetingEnemyBot = false;
        this.currentTarget = null;
        this.maxHuntDistance = 600;
        this.playerFollowPriority = 900;
        this.lastBulletTime = 0;
        this.bulletFreshness = 2000;
        this.safeDistance = 120;
        this.splitRunCooldown = 0;
        this.playerSplitTracking = null;
    }

    getPlayerCenter(player) {
        return player.getWeightedCenter?.() || player.centerPos;
    }

    getPlayerBiggest(player) {
        return player.getLargest?.(player.cells) || this.getPlayerCenter(player);
    }

    feedPlayerMass(player) {
        const target = this.getPlayerBiggest(player);
        const targetPos = target.position ?? target;
        const obstacle = this.getObstacleInPath(this.centerPos, targetPos);
        if (obstacle) {
            this.mouse = this.calculateAvoidancePosition(obstacle.position);
            return;
        }
        this.mouse = targetPos;
        for (let i = 0; i < 6; i++) {
            this.gameServer.ejectMass(this);
        }
    }

    onEatBullet(feeder) {
        const now = Date.now();
        if (now - this.lastBulletTime > this.bulletFreshness) {
            this.bulletsFed = 0;
        }
        if ((!this.teamingWith || feeder === this.teamingWith) &&
            (feeder.lastEject === undefined || now - feeder.lastEject < this.bulletFreshness)) {
            this.bulletsFed++;
            this.lastBulletTime = now;
            if (this.bulletsFed >= 10 && !this.teamingWith) {
                const hasTeammate = this.gameServer.clients.some(c => 
                    c.playerTracker?.teamingWith === feeder && c.playerTracker !== this
                );
                if (!hasTeammate) {
                    this.teamingWith = feeder;
                    // Save the teammate's unique id so that we can rejoin if they respawn
                    this.targetTeammateID = feeder._id;
                    this.gameServer.sendChatMessage(null, feeder, "🤖 Bot joined your team!");
                }
            }
        }
    }

    sendUpdate() {
        // Clear teaming info if teammate has died.
        if (this.teamingWith && (!this.teamingWith.cells || this.teamingWith.cells.length === 0)) {
            this.teamingWith = null;
            this.color = this.originalColor;
            this.bulletsFed = 0;
        }
        // If not currently teamed but with a saved teammate id, try to rejoin.
        if (!this.teamingWith && this.targetTeammateID) {
            const potential = this.gameServer.clients.find(c => 
                c.playerTracker && c.playerTracker._id === this.targetTeammateID
            );
            if (potential && potential.playerTracker && potential.playerTracker.cells && potential.playerTracker.cells.length > 0) {
                this.teamingWith = potential.playerTracker;
                this.mouse = this.getPlayerCenter(this.teamingWith);
                this.gameServer.sendChatMessage(null, this.teamingWith, "🤖 Bot rejoined your team!");
            }
        }
        // Run team behavior if teamed; otherwise, use standard behavior.
        if (this.teamingWith?.socket?.isConnected) {
            this.teamBehaviorCycle();
        } else {
            this.standardBotBehavior();
        }
        this.checkConnection();
    }

    decideBehavior(cell) {
        if (!cell) return;
        if (this.teamingWith && this.getDistanceToPlayer(this.teamingWith) > this.playerFollowPriority) {
            this.mouse = this.predictPlayerPosition(this.teamingWith);
            return;
        }
        let result = new Vector(0, 0);
        let prey = null;
        if (this.splitTarget) {
            if (this.splitTarget.isRemoved) {
                this.splitTarget = null;
                this.targetPursuit = 0;
                this.isTargetingEnemyBot = false;
            }
            if (this.targetPursuit > 0) {
                this.targetPursuit--;
                this.mouse = { x: this.splitTarget.position.x, y: this.splitTarget.position.y };
                return;
            }
            this.splitTarget = null;
            this.isTargetingEnemyBot = false;
        }
        const merge = this.gameServer.config.playerMergeTime <= 0;
        const canSplit = this.cells.length < this.gameServer.config.playerMaxCells;
        const splitReady = !this.splitCooldown && canSplit;
        const size = cell._size / 1.3;
        for (let check of this.viewNodes) {
            if (check.owner !== this) {
                let influence = 0;
                if (check.cellType === 0) {
                    if (check.owner?.isBot && this.teamingWith) {
                        if (cell._size > check._size * 1.3) {
                            influence = 2.5;
                            this.isTargetingEnemyBot = true;
                        } else if (check._size > cell._size * 1.3) {
                            influence = -2.5;
                        }
                    } else if (cell._size > check._size * 1.3) {
                        influence = check._size / Math.log(this.viewNodes.length);
                    } else if (check._size > cell._size * 1.3) {
                        influence = -Math.log(check._size / cell._size);
                    } else {
                        influence = -check._size / cell._size;
                    }
                } else if (check.cellType === 1) {
                    influence = 1;
                } else if (check.cellType === 2) {
                    if (cell._size > check._size * 1.3) {
                        influence = canSplit ? -1 : 2;
                    } else if (check.isMotherCell && check._size > cell._size * 1.3) {
                        influence = -1;
                    }
                } else if (check.cellType === 3 && cell._size > check._size * 1.3) {
                    influence = 2;
                }
                if (influence !== 0) {
                    let displacement = new Vector(
                        check.position.x - cell.position.x,
                        check.position.y - cell.position.y
                    );
                    let dist = displacement.length();
                    if (influence < 0) dist -= cell._size + check._size;
                    if (dist < 1) dist = 1;
                    influence /= dist;
                    displacement.normalize().scale(influence);
                    if (splitReady && check.cellType === 0 && size > 1.3 * check._size) {
                        if (cell._size * (merge ? 0.1 : 0.4) < check._size && this.splitKill(cell, check, dist)) {
                            if (!prey || check._size > prey._size) {
                                prey = check;
                            }
                        }
                    }
                    result.add(displacement);
                }
            }
        }
        if (this.teamingWith) {
            const playerPos = this.predictPlayerPosition(this.teamingWith);
            const playerVector = new Vector(
                playerPos.x - cell.position.x,
                playerPos.y - cell.position.y
            ).normalize().scale(0.8);
            result.add(playerVector);
        }
        result.normalize();
        this.mouse = {
            x: cell.position.x + result.x * this.viewBox.halfWidth,
            y: cell.position.y + result.y * this.viewBox.halfWidth
        };
        if (prey) {
            this.mouse = prey.position;
            this.splitTarget = prey;
            this.targetPursuit = merge ? 5 : 20;
            this.splitCooldown = merge ? 5 : 15;
            this.gameServer.splitCells(this);
        }
    }

    splitKill(cell, prey, dist) {
        if (prey.cellType === 2) {
            return 1.3 * this.gameServer.config.virusShotSpeed - cell._size / 2 - prey._size >= dist;
        }
        const speed = Math.max(1.3 * this.gameServer.config.playerSplitSpeed, cell._size / 1.4142 * 4.5);
        return speed >= dist;
    }

    getObstacleInPath(from, to) {
        for (const cell of this.viewNodes) {
            if (cell.owner === this.teamingWith || cell.owner === this) continue;
            if (cell.cellType !== 2 && (!cell.owner || !cell.owner.isBot)) continue;
            if (this.distanceToLine(from, to, cell.position) < cell._size) {
                return cell;
            }
        }
        return null;
    }

    distanceToLine(a, b, p) {
        const A = p.x - a.x;
        const B = p.y - a.y;
        const C = b.x - a.x;
        const D = b.y - a.y;
        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = lenSq !== 0 ? dot / lenSq : -1;
        let xx, yy;
        if (param < 0) {
            xx = a.x;
            yy = a.y;
        } else if (param > 1) {
            xx = b.x;
            yy = b.y;
        } else {
            xx = a.x + param * C;
            yy = a.y + param * D;
        }
        return Math.hypot(p.x - xx, p.y - yy);
    }

    calculateAvoidancePosition(obstaclePos) {
        const angle = Math.atan2(
            obstaclePos.y - this.centerPos.y,
            obstaclePos.x - this.centerPos.x
        );
        const avoidDistance = 150;
        return {
            x: this.centerPos.x + Math.cos(angle + Math.PI / 2) * avoidDistance,
            y: this.centerPos.y + Math.sin(angle + Math.PI / 2) * avoidDistance
        };
    }

    virusHuntForTeam(player, currentTime) {
        const playerMass = player.getTotalMass ? player.getTotalMass() : 0;
        if (playerMass >= 3000) return false;
        const viruses = this.viewNodes.filter(c => c.cellType === 2 && this.getDistanceTo(c.position) < 400);
        if (viruses.length > 0) {
            const virus = viruses[0];
            this.mouse = virus.position;
            if (this.getDistanceTo(virus.position) < 50 && currentTime - this.lastVirusSplit > 1500) {
                this.gameServer.splitCells(this);
                this.lastVirusSplit = currentTime;
            }
            return true;
        }
        return false;
    }

    analyzeSelfThreats() {
        const now = Date.now();
        this.combatMemory.forEach((timestamp, threat) => {
            if (now - timestamp > this.threatResponseDelay) {
                this.combatMemory.delete(threat);
            }
        });
        for (const cell of this.cells) {
            for (const other of this.viewNodes) {
                if (!other.owner || other.owner === this.teamingWith) continue;
                if (other._mass > cell._mass * 1.15) {
                    const dist = this.getDistanceBetween(cell.position, other.position);
                    if (dist < cell._size * 3) {
                        this.combatMemory.set(other, Date.now());
                        return other;
                    }
                }
            }
        }
        return null;
    }

    teamBehaviorCycle() {
        const player = this.teamingWith;
        const currentTime = Date.now();
        // If player's mass is low, try virus hunting.
        if (player && player.getTotalMass && player.getTotalMass() < 3000) {
            if (this.virusHuntForTeam(player, currentTime)) {
                if (this.getDistanceTo(player.centerPos) < 100) {
                    this.feedPlayerMass(player);
                }
                return;
            }
        }
        // If already targeting an enemy bot, focus on attacking it.
        if (this.currentTarget) {
            if (this.currentTarget.isRemoved) {
                // Once the target is eliminated, feed the player and clear the target.
                this.feedPlayerMass(player);
                this.resetHuntingState();
            } else {
                this.executeTargetedAttack();
                return;
            }
        }
        // Look for a new enemy bot target.
        const playerTarget = this.detectPlayerTarget(player);
        if (playerTarget && !this.currentTarget) {
            this.currentTarget = playerTarget;
            this.isTargetingEnemyBot = true;
            this.gameServer.sendChatMessage(null, player, "🤖 Bot targeting enemy bot!");
            this.executeTargetedAttack();
            return;
        }
        // No enemy target – follow the player and perform feeding as normal.
        this.maintainCombatPosition(player);
        if (this.handleViruses(player, currentTime)) return;
        if (this.handleCombatFeeding(player, currentTime)) return;
        if (this.handleNormalFeeding(player, currentTime)) return;
        if (this.handleBulletCollection(player)) return;
        this.standardBotBehavior();
        this.collectPlayerFragments(player);
        this.handleSplitRunning(player);
    }

    detectPlayerTarget(player) {
        if (!player?.mouse) return null;
        const mousePos = player.mouse;
        let closestEnemy = null;
        let minDist = Infinity;
        const ourMass = this.getTotalMass();
        for (const cell of this.viewNodes) {
            if (cell.owner && cell.owner !== player && cell.owner !== this && cell.owner.isBot) {
                // Only consider enemy bots that are “killable.”
                if (ourMass < cell._mass * 1.3) continue;
                const dist = this.getDistanceBetween(mousePos, cell.position);
                if (dist < 250 && dist < minDist) {
                    closestEnemy = cell;
                    minDist = dist;
                }
            }
        }
        return closestEnemy;
    }

    executeTargetedAttack() {
        if (!this.currentTarget) return;
        const largest = this.getLargest(this.cells);
        if (!largest) return;
        const dist = this.getDistanceBetween(largest.position, this.currentTarget.position);
        // If in range and able, attempt a split kill.
        if (this.splitCooldown <= 0 && this.splitKill(largest, this.currentTarget, dist)) {
            this.gameServer.splitCells(this);
            this.splitCooldown = this.gameServer.config.playerMergeTime <= 0 ? 5 : 15;
        }
        // Move toward the target.
        this.mouse = this.currentTarget.position;
    }

    resetHuntingState() {
        this.currentTarget = null;
        this.isTargetingEnemyBot = false;
        this.splitCooldown = 0;
        if (this.teamingWith) {
            this.mouse = this.getPlayerCenter(this.teamingWith);
        }
    }

    maintainCombatPosition(player) {
        const playerCenter = this.getPlayerCenter(player);
        let followDirection = { x: 0, y: 0 };
        if (player.mouse) {
            followDirection.x = player.mouse.x - playerCenter.x;
            followDirection.y = player.mouse.y - playerCenter.y;
        }
        if (Math.hypot(followDirection.x, followDirection.y) < 0.1) {
            followDirection.x = this.centerPos.x - playerCenter.x;
            followDirection.y = this.centerPos.y - playerCenter.y;
        }
        const angle = Math.atan2(followDirection.y, followDirection.x);
        const offsetDistance = this.baseFollowRadius;
        let targetPos = {
            x: playerCenter.x - Math.cos(angle) * offsetDistance,
            y: playerCenter.y - Math.sin(angle) * offsetDistance
        };
        const nearbyEnemies = this.viewNodes.filter(c => 
            c.owner && c.owner !== player && c.owner !== this && 
            this.getDistanceBetween(playerCenter, c.position) < 300
        );
        let avoidVector = { x: 0, y: 0 };
        nearbyEnemies.forEach(enemy => {
            const dx = targetPos.x - enemy.position.x;
            const dy = targetPos.y - enemy.position.y;
            const distance = Math.hypot(dx, dy);
            if (distance > 0) {
                avoidVector.x += dx / distance;
                avoidVector.y += dy / distance;
            }
        });
        const avoidScale = 50;
        targetPos.x += avoidVector.x * avoidScale;
        targetPos.y += avoidVector.y * avoidScale;
        const obstacle = this.getObstacleInPath(this.centerPos, targetPos);
        if (obstacle) {
            const avoidancePos = this.calculateAvoidancePosition(obstacle.position);
            targetPos.x = (targetPos.x + avoidancePos.x) / 2;
            targetPos.y = (targetPos.y + avoidancePos.y) / 2;
        }
        const smoothingFactor = 0.2;
        if (!this.mouse) {
            this.mouse = { x: this.centerPos.x, y: this.centerPos.y };
        }
        this.mouse = {
            x: this.mouse.x + (targetPos.x - this.mouse.x) * smoothingFactor,
            y: this.mouse.y + (targetPos.y - this.mouse.y) * smoothingFactor
        };
    }

    calculatePlayerSpeed(player) {
        const positions = player.cells.map(c => c.position);
        if (positions.length < 2) return 0;
        const dx = positions[0].x - positions[1].x;
        const dy = positions[0].y - positions[1].y;
        return Math.hypot(dx, dy);
    }

    handleSplitRunning(player) {
        if (!player.cells) return;
        if (player.cells.length > (this.playerSplitTracking?.count || 0)) {
            if (this.splitRunCooldown <= 0 && this.cells.length < 16) {
                const splitDirection = player.mouse;
                const angle = Math.atan2(
                    splitDirection.y - this.centerPos.y,
                    splitDirection.x - this.centerPos.x
                );
                this.mouse = {
                    x: this.centerPos.x + Math.cos(angle) * 1000,
                    y: this.centerPos.y + Math.sin(angle) * 1000
                };
                this.gameServer.splitCells(this);
                this.splitRunCooldown = 800;
            }
        }
        this.playerSplitTracking = {
            count: player.cells.length,
            time: Date.now()
        };
    }

    handleViruses(player, currentTime) {
        if (!this.teamingWith) return false;
        if (currentTime - this.lastVirusSplit > 1500) {
            const viruses = this.viewNodes.filter(c => c.cellType === 2);
            for (const virus of viruses) {
                if (this.canSplitVirus(virus)) {
                    this.mouse = virus.position;
                    this.gameServer.splitCells(this);
                    this.lastVirusSplit = currentTime;
                    return true;
                }
            }
        }
        const fragments = this.viewNodes.filter(c => 
            c.cellType === 1 && 
            this.getDistanceTo(c.position) < 400 &&
            (c._mass < 30 || this.getTotalMass() > c._mass * 1.2)
        );
        if (fragments.length > 0) {
            const fragment = fragments.reduce((min, f) => f._mass < min._mass ? f : min, fragments[0]);
            this.mouse = fragment.position;
            if (this.getDistanceTo(fragment.position) < 50) {
                this.feedPlayerMass(player);
            }
            return true;
        }
        return false;
    }

    canSplitVirus(virus) {
        return this.teamingWith &&
               this.getTotalMass() > virus._mass * 1.3 &&
               this.getDistanceTo(virus.position) < 250 &&
               !this.analyzeSelfThreats();
    }

    handleCombatFeeding(player, currentTime) {
        const botMass = this.getTotalMass();
        const playerMass = player.getTotalMass?.() || 0;
     if (this.combatCooldown > Date.now()) return false;
        const shouldFeed = this.analyzeThreats(player) || 
                           this.isPlayerChasing(player) || 
                           this.getDistanceToPlayer(player) < 400;
        if (shouldFeed & botMass >= playerMass * .3) {
            this.assistMode = "combat";
            if (currentTime - this.lastAction > this.feedInterval) {
                this.feedPlayerMass(player);
                this.lastAction = currentTime;
                this.combatCooldown = Date.now() + 50;
            }
            return true;
        }
        return false;
    }

    handleNormalFeeding(player, currentTime) {
        const playerMass = player.getTotalMass?.() || 0;
        if (playerMass < this.minFeedMass) {
            this.assistMode = "feed";
            if (currentTime - this.lastAction > this.feedInterval) {
                this.feedPlayerMass(player);
                this.lastAction = currentTime;
            }
            return true;
        }
        const botMass = this.getTotalMass();
        if (playerMass < botMass * 0.8) {
            this.assistMode = "feed";
            if (currentTime - this.lastAction > this.feedInterval) {
                this.feedPlayerMass(player);
                this.lastAction = currentTime;
            }
            return true;
        }
        return false;
    }

    handleBulletCollection(player) {
        const bullets = this.viewNodes.filter(c =>
            c.cellType === 3 && this.getDistanceTo(c.position) < 800
        );
        if (bullets.length > 0) {
            const closestBullet = bullets.reduce((closest, bullet) => 
                (this.getDistanceTo(bullet.position) < this.getDistanceTo(closest.position) ? bullet : closest),
                bullets[0]
            );
            this.mouse = closestBullet.position;
            if (this.getDistanceTo(closestBullet.position) < 50) {
                this.feedPlayerMass(player);
            }
            return true;
        }
        return false;
    }

    collectPlayerFragments(player) {
        const fragments = this.viewNodes.filter(c => 
            c.owner === player && 
            c._mass < 25 && 
            this.getDistanceTo(c.position) < 600
        );
        if (fragments.length > 0) {
            this.mouse = fragments[0].position;
        }
    }

    predictPlayerPosition(player) {
        const playerPos = this.getPlayerCenter(player);
        if (!player?.mouse) return playerPos;
        const dx = player.mouse.x - playerPos.x;
        const dy = player.mouse.y - playerPos.y;
        const dist = Math.hypot(dx, dy);
        const largest = player.getLargest?.(player.cells);
        const speed = largest?.getSpeed?.() || 10;
        const t = Math.min(dist / (speed * 1.2), 1.2);
        return {
            x: playerPos.x + dx * t,
            y: playerPos.y + dy * t
        };
    }

    analyzeThreats(player) {
        const playerPos = this.getPlayerCenter(player);
        for (const cell of this.viewNodes) {
            if (!cell.owner || cell.owner === player || cell.owner === this) continue;
            if (this.getDistanceBetween(cell.position, playerPos) < 500) return true;
        }
        return false;
    }

    isPlayerChasing(player) {
        const playerMouse = player.mouse;
        for (const cell of this.viewNodes) {
            if (!cell.owner || cell.owner === player || cell.owner === this) continue;
            const d = Math.hypot(cell.position.x - playerMouse.x, cell.position.y - playerMouse.y);
            if (d < 250) return true;
        }
        return false;
    }

    getDistanceToPlayer(player) {
        return this.getDistanceBetween(this.centerPos, this.getPlayerCenter(player));
    }

    standardBotBehavior() {
        const largest = this.getLargest(this.cells);
        this.decideBehavior(largest);
    }

    calculateCellInfluence(self, other) {
        if (other.cellType === 2 && this.teamingWith) {
            return this.canSplitVirus(other) ? 2.0 : -0.5;
        }
        if (other.owner?.isBot && this.assistMode === "combat") return -1.5;
        const sizeRatio = self._size / other._size;
        if (sizeRatio > 1.3) return 1.1;
        if (sizeRatio < 0.7) return -1.2;
        return other.cellType === 1 ? 0.7 : -0.4;
    }

    getLargest(list) {
        if (!list?.length) return null;
        return list.reduce((max, cell) => cell._mass > (max?._mass || 0) ? cell : max, null);
    }

    getTotalMass() {
        return this.cells?.reduce((sum, c) => sum + (c._mass || 0), 0) || 0;
    }

    getDistanceBetween(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    getDistanceTo(pos) {
        return this.getDistanceBetween(this.centerPos, pos);
    }

    checkConnection() {
        if (this.socket.isCloseReq) {
            this.cells?.forEach(c => this.gameServer.removeNode(c));
            this.isRemoved = true;
        } else if (!this.cells?.length) {
            this.gameServer.gameMode.onPlayerSpawn(this.gameServer, this);
            if (!this.cells?.length) this.socket.close();
        }
    }
}

module.exports = BotPlayer;