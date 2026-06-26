/**
 * Class for writing game logic functions and steps in a more readable way.
 * Purpose is to remove game logic from server.js, which I would like to basically just have framework code.
 */

var config = require("../../../config.json");
var Wall = require("./wall");
var Bullet = require("./bullet");
var Track = require("./track");
var Direction = require("./direction");
var util = require("./util");
var winston = require("winston");
winston.level = "debug";

class GameLogicService {
    constructor(quadtreeManager, spatialHashManager) {
        this.quadtreeManager = quadtreeManager;
        this.quadtree = quadtreeManager.getQuadtree();
        this.spatialHashManager = spatialHashManager;
    }

    initializeGame() {
        var leftBorderWall = new Wall(
            0,
            0,
            config.wall.width,
            config.gameHeight,
        );
        var topBorderWall = new Wall(0, 0, config.gameWidth, config.wall.width);
        var rightBorderWall = new Wall(
            config.gameWidth - config.wall.width,
            0,
            config.wall.width,
            config.gameHeight,
        );
        var bottomBorderWall = new Wall(
            0,
            config.gameHeight - config.wall.width,
            config.gameWidth,
            config.wall.width,
        );

        this.quadtree.put(leftBorderWall.forQuadtree());
        this.quadtree.put(topBorderWall.forQuadtree());
        this.quadtree.put(rightBorderWall.forQuadtree());
        this.quadtree.put(bottomBorderWall.forQuadtree());

        for (var i = 0; i < config.wall.count; i++) {
            var x = Math.floor(Math.random() * config.gameWidth);
            var y = Math.floor(Math.random() * config.gameHeight);
            var w, h;

            if (i % 2 === 0) {
                w = Math.max(
                    config.wall.minDimension,
                    Math.floor(Math.random() * (config.wall.maxDimension / 3)),
                );
                h = Math.max(
                    config.wall.minDimension,
                    Math.floor(Math.random() * config.wall.maxDimension),
                );
            } else {
                w = Math.max(
                    config.wall.minDimension,
                    Math.floor(Math.random() * config.wall.maxDimension),
                );
                h = Math.max(
                    config.wall.minDimension,
                    Math.floor(Math.random() * (config.wall.maxDimension / 3)),
                );
            }

            var wall = new Wall(
                x,
                y,
                Math.min(config.gameWidth - x, w),
                Math.min(config.gameHeight - y, h),
            );
            this.quadtree.put(wall.forQuadtree());
        }
    }

    gameTick(clientData, socket, currentClientDatas) {
        var currentTime = new Date().getTime();

        if (clientData.lastHeartbeat < currentTime - config.maxLastHeartBeat) {
            winston.log(
                "debug",
                `Kicking player ${clientData.tank.screenName}`,
            );
            this.quadtree.remove(clientData.tank.forQuadtree(), "id");
            socket.emit("death");
            socket.disconnect();
        } else {
            this.updateTank(clientData);
            this.increaseAmmoIfNecessary(clientData, currentTime);
            this.updatePositionsOfBullets(
                clientData,
                this.quadtreeManager,
                currentTime,
            );
            this.fireBulletsIfNecessary(clientData, currentTime);
            this.handleCollisionsOnTank(clientData, socket, currentClientDatas);
        }
    }

    gameTickSpectator(clientData, socket) {
        var currentTime = new Date().getTime();

        if (clientData.lastHeartbeat < currentTime - config.maxLastHeartBeat) {
            winston.log(
                "debug",
                `Kicking spectator ${clientData.tank.screenName}`,
            );
            socket.emit("death");
            socket.disconnect();
        } else {
            this.updateSpectatorPosition(clientData);
        }
    }

    updateSpectatorPosition(clientData) {
        let player = clientData.player;
        var oldPosition = clientData.position;
        var newPosition = {
            x: clientData.position.x,
            y: clientData.position.y,
        };
        let xChange = 0;
        let yChange = 0;

        if (player.userInput.keysPressed["KEY_RIGHT"])
            xChange += config.spectatorSpeed;
        if (player.userInput.keysPressed["KEY_LEFT"])
            xChange -= config.spectatorSpeed;
        if (player.userInput.keysPressed["KEY_DOWN"])
            yChange += config.spectatorSpeed; // SỬA: Trước đó ghi nhầm xChange
        if (player.userInput.keysPressed["KEY_UP"])
            yChange -= config.spectatorSpeed;

        if (xChange !== 0 && yChange !== 0) {
            let diagSpeedFactor = Math.sqrt(
                Math.pow(config.spectatorSpeed, 2) / 2,
            );
            xChange = Math.sign(xChange) * diagSpeedFactor;
            yChange = Math.sign(yChange) * diagSpeedFactor;
        }

        if (player.userInput.keysPressed["KEY_SPACE"]) {
            xChange *= config.tank.boostFactor;
            yChange *= config.tank.boostFactor;
        }

        newPosition.x = oldPosition.x + xChange;
        newPosition.y = oldPosition.y + yChange;
        clientData.position = newPosition;
    }

    updateTank(clientData) {
        let player = clientData.player;
        let tank = clientData.tank;

        tank.gunAngle = player.userInput.mouseAngle;

        var oldTank = tank.forQuadtree();
        var oldPosition = clientData.position;
        var newPosition = {
            x: clientData.position.x,
            y: clientData.position.y,
        };

        let xChange = 0;
        let yChange = 0;

        if (player.userInput.keysPressed["KEY_RIGHT"])
            xChange += config.tank.normalSpeed;
        if (player.userInput.keysPressed["KEY_LEFT"])
            xChange -= config.tank.normalSpeed;
        if (player.userInput.keysPressed["KEY_DOWN"])
            yChange += config.tank.normalSpeed;
        if (player.userInput.keysPressed["KEY_UP"])
            yChange -= config.tank.normalSpeed;

        if (xChange !== 0 && yChange !== 0) {
            let diagSpeedFactor = Math.sqrt(
                Math.pow(config.tank.normalSpeed, 2) / 2,
            );
            xChange = Math.sign(xChange) * diagSpeedFactor;
            yChange = Math.sign(yChange) * diagSpeedFactor;
        }

        if (player.userInput.keysPressed["KEY_SPACE"]) {
            if (tank.boostRemaining > 0) {
                xChange *= config.tank.boostFactor;
                yChange *= config.tank.boostFactor;
                tank.boostRemaining = Math.max(0, tank.boostRemaining - 2);
            }
        } else {
            tank.boostRemaining = Math.min(
                config.tank.boostCapacity || 100,
                tank.boostRemaining + 1,
            );
        }

        newPosition.x = oldPosition.x + xChange;
        newPosition.y = oldPosition.y + yChange;

        if (!util.areCoordinatesEqual(oldPosition, newPosition)) {
            let angleInRadians = Math.atan2(
                newPosition.y - oldPosition.y,
                newPosition.x - oldPosition.x,
            );
            angleInRadians = Number(
                (angleInRadians + 2 * Math.PI) % (2 * Math.PI),
            ).toFixed(5);
            tank.hullAngle = angleInRadians;
            tank.spriteTankHull.update();
            this.addTracks(tank, newPosition, angleInRadians);
        }

        // Truy vấn va chạm tại vị trí mới
        var objects = this.quadtreeManager.queryGameObjectsForType(
            ["WALL", "TANK"],
            {
                x: newPosition.x - config.tank.width / 2,
                y: newPosition.y - config.tank.height / 2,
                w: config.tank.width,
                h: config.tank.height,
            },
        );

        // SỬA: Lọc bỏ chính mình khỏi danh sách va chạm xe tăng
        let otherTanks = objects["TANK"].filter((t) => t.id !== clientData.id);

        if (!objects["WALL"].length && otherTanks.length === 0) {
            clientData.position = newPosition;
            tank.x = newPosition.x; // SỬA: Cập nhật đồng bộ tọa độ của tank object
            tank.y = newPosition.y;

            this.quadtree.remove(oldTank, "id");
            this.quadtree.put(tank.forQuadtree());
        }
    }

    addTracks(tank, newPosition, angleInRadians) {
        if (!tank.path.hasFinishedDelay()) return;
        let track1DestX = 0,
            track1DestY = 0,
            track2DestX = 0,
            track2DestY = 0;
        let scaledHalfSingleFrame =
            (tank.spriteTankHull.singleFrameWidth / 2) *
            tank.spriteTankHull.scaleFactorWidth;
        let straightCorrection = 0.52941 * scaledHalfSingleFrame;
        let diagonalCorrection = 0.75294 * scaledHalfSingleFrame;

        switch (parseFloat(angleInRadians)) {
            case Direction.E:
                track1DestX = newPosition.x + straightCorrection;
                track1DestY = newPosition.y - straightCorrection;
                track2DestX = newPosition.x + straightCorrection;
                track2DestY = newPosition.y + straightCorrection;
                break;
            case Direction.SE:
                track1DestX = newPosition.x;
                track1DestY = newPosition.y + diagonalCorrection;
                track2DestX = newPosition.x + diagonalCorrection;
                track2DestY = newPosition.y;
                break;
            case Direction.S:
                track1DestX = newPosition.x - straightCorrection;
                track1DestY = newPosition.y + straightCorrection;
                track2DestX = newPosition.x + straightCorrection;
                track2DestY = newPosition.y + straightCorrection;
                break;
            case Direction.SW:
                track1DestX = newPosition.x - diagonalCorrection;
                track1DestY = newPosition.y;
                track2DestX = newPosition.x;
                track2DestY = newPosition.y + diagonalCorrection;
                break;
            case Direction.W:
                track1DestX = newPosition.x - straightCorrection;
                track1DestY = newPosition.y - straightCorrection;
                track2DestX = newPosition.x - straightCorrection;
                track2DestY = newPosition.y + straightCorrection;
                break;
            case Direction.NW:
                track1DestX = newPosition.x - diagonalCorrection;
                track1DestY = newPosition.y;
                track2DestX = newPosition.x;
                track2DestY = newPosition.y - diagonalCorrection;
                break;
            case Direction.N:
                track1DestX = newPosition.x - straightCorrection;
                track1DestY = newPosition.y - straightCorrection;
                track2DestX = newPosition.x + straightCorrection;
                track2DestY = newPosition.y - straightCorrection;
                break;
            case Direction.NE:
                track1DestX = newPosition.x;
                track1DestY = newPosition.y - diagonalCorrection;
                track2DestX = newPosition.x + diagonalCorrection;
                track2DestY = newPosition.y;
                break;
        }

        let track1 = new Track(
            track1DestX,
            track1DestY,
            angleInRadians,
            tank.path.id,
        );
        let track2 = new Track(
            track2DestX,
            track2DestY,
            angleInRadians,
            tank.path.id,
        );
        this.spatialHashManager.insertTrack(track1);
        this.spatialHashManager.insertTrack(track2);
    }

    increaseAmmoIfNecessary(clientData, time) {
        if (
            clientData.tank.ammo < config.tank.ammoCapacity &&
            (time - clientData.tank.lastAmmoEarned >
                config.tank.timeToGainAmmo ||
                typeof clientData.tank.lastAmmoEarned === "undefined")
        ) {
            clientData.tank.ammo = clientData.tank.ammo + 1;
            clientData.tank.lastAmmoEarned = time;
        }
    }

    updatePositionsOfBullets(clientData, quadtreeManager, time) {
        for (var bullet of clientData.tank.bullets) {
            if (time - bullet.timeCreated > config.bullet.timeToLive) {
                let bulletIndex = util.findIndex(
                    clientData.tank.bullets,
                    bullet.id,
                );
                if (bulletIndex > -1) {
                    clientData.tank.bullets.splice(bulletIndex, 1);
                    this.quadtree.remove(bullet.forQuadtree(), "id");
                }
            } else {
                let currentBulletLocation = bullet.forQuadtree();
                var walls = quadtreeManager.queryGameObjectsForType(
                    ["WALL"],
                    currentBulletLocation,
                )["WALL"];

                for (var wallId of bullet.wallsInsideOf) {
                    if (walls.indexOf(wallId) === -1) {
                        bullet.wallsInsideOf.splice(
                            bullet.wallsInsideOf.indexOf(wallId),
                            1,
                        );
                    }
                }

                for (var j = 0; j < walls.length; j++) {
                    var wall = walls[j];
                    if (bullet.wallsInsideOf.indexOf(wall.id) === -1) {
                        bullet.wallsInsideOf.push(wall.id);
                        if (bullet.oldX + config.bullet.width < wall.x) {
                            bullet.velocityX = -bullet.velocityX;
                        } else if (bullet.oldX > wall.x + wall.w) {
                            bullet.velocityX = -bullet.velocityX;
                        } else if (
                            bullet.oldY + config.bullet.height <
                            wall.y
                        ) {
                            bullet.velocityY = -bullet.velocityY;
                        } else if (bullet.oldY > wall.y + wall.h) {
                            bullet.velocityY = -bullet.velocityY;
                        }
                    }
                }

                bullet.oldX = bullet.x;
                bullet.oldY = bullet.y;
                bullet.x = bullet.x + bullet.velocityX;
                bullet.y = bullet.y + bullet.velocityY;

                let forQuadtree = bullet.forQuadtree();
                this.quadtree.remove(currentBulletLocation, "id");
                this.quadtree.put(forQuadtree);
            }
        }
    }

    fireBulletsIfNecessary(clientData, time) {
        if (
            clientData.player.userInput.mouseClicked &&
            clientData.tank.ammo > 0 &&
            (typeof clientData.tank.lastFireTime === "undefined" ||
                time - clientData.tank.lastFireTime > config.tank.fireTimeWait)
        ) {
            clientData.tank.lastFireTime = time;
            clientData.tank.ammo = clientData.tank.ammo - 1;

            var xComponent = Math.cos(clientData.tank.gunAngle);
            var yComponent = -Math.sin(clientData.tank.gunAngle);

            var bulletStartX =
                clientData.tank.x + xComponent * config.tank.barrelLength;
            var bulletStartY =
                clientData.tank.y + yComponent * config.tank.barrelLength;

            var walls = this.quadtreeManager.queryGameObjectsForType(["WALL"], {
                x: bulletStartX,
                y: bulletStartY,
                w: config.bullet.width,
                h: config.bullet.height,
            })["WALL"];

            if (!walls.length) {
                var bullet = new Bullet(
                    clientData.id,
                    bulletStartX,
                    bulletStartY,
                    xComponent * config.bullet.velocity,
                    yComponent * config.bullet.velocity,
                );

                this.quadtree.put(bullet.forQuadtree());
                clientData.tank.bullets.push(bullet);
            }
        }
    }

    handleCollisionsOnTank(clientData, socket, currentClientDatas) {
        var objectsInTankArea = this.quadtree.get(
            clientData.tank.forQuadtree(),
        );
        for (var objectInTankArea of objectsInTankArea) {
            if (objectInTankArea.type === "BULLET") {
                var bullet = objectInTankArea.object;

                // SỬA: Không thể tự bắn trúng đạn của chính mình phát ra
                if (bullet.ownerId === clientData.id) continue;

                if (typeof clientData.tank.hp === "undefined") {
                    clientData.tank.hp = 100;
                }

                clientData.tank.hp -= 20;
                socket.emit("hp_update", clientData.tank.hp);

                var playerIndex = util.findIndex(
                    currentClientDatas,
                    bullet.ownerId,
                );
                if (playerIndex > -1) {
                    var bulletIndex = util.findIndex(
                        currentClientDatas[playerIndex].tank.bullets,
                        bullet.id,
                    );
                    if (bulletIndex > -1) {
                        currentClientDatas[playerIndex].tank.bullets.splice(
                            bulletIndex,
                            1,
                        );
                        this.quadtree.remove(bullet.forQuadtree(), "id");
                    }
                }

                if (clientData.tank.hp <= 0) {
                    if (playerIndex > -1) {
                        currentClientDatas[playerIndex].tank.kills =
                            currentClientDatas[playerIndex].tank.kills + 1;
                    }
                    this.kill(clientData, socket);
                }
            }
        }
    }

    kill(clientData, socket) {
        socket.emit("death");
        winston.log("debug", `Respawning player ${clientData.tank.screenName}`);

        clientData.tank.hp = 100;
        let spawnPoint = GameLogicService.getSpawnLocation(
            this.quadtreeManager,
        );

        this.quadtree.remove(clientData.tank.forQuadtree(), "id");

        clientData.position = spawnPoint;
        clientData.tank.x = spawnPoint.x;
        clientData.tank.y = spawnPoint.y;

        this.quadtree.put(clientData.tank.forQuadtree());

        socket.emit("welcome", clientData, {
            gameWidth: config.gameWidth,
            gameHeight: config.gameHeight,
        });
    }

    // ĐÃ TỐI ƯU: Loại bỏ vòng lặp vô hạn gây sập server
    static getSpawnLocation(quadtreeManager) {
        let attempts = 0;
        let maxAttempts = 50; // Giới hạn tối đa 50 lần tìm kiếm tọa độ

        while (attempts < maxAttempts) {
            var x = Math.floor(Math.random() * config.gameWidth);
            var y = Math.floor(Math.random() * config.gameHeight);

            var objects = quadtreeManager.queryGameObjectsForType(
                ["BULLET", "WALL", "TANK"],
                {
                    x: x - config.spawnAreaWidth / 2,
                    y: y - config.spawnAreaHeight / 2,
                    w: config.spawnAreaWidth,
                    h: config.spawnAreaHeight,
                },
            );

            let isEmpty = true;
            for (var key of Object.keys(objects)) {
                if (objects.hasOwnProperty(key) && objects[key].length > 0) {
                    isEmpty = false;
                    break;
                }
            }

            if (isEmpty) {
                return { x: x, y: y };
            }
            attempts++;
        }

        // Fallback: Nếu Map quá chật, trả về vị trí trung tâm an toàn thay vì block server
        return {
            x: Math.floor(config.gameWidth / 2),
            y: Math.floor(config.gameHeight / 2),
        };
    }
}

module.exports = GameLogicService;
