/**
 * 1. BASIC SERVER SETUP
 * First set up everything necessary for serving up the index.html page
 * with its static assets
 */

"use strict";

var express = require("express");
var app = express();
var http = require("http").Server(app);
var socketIo = require("socket.io")(http);
var path = require("path");
var winston = require("winston");
winston.level = "debug";

// Import application config
var config = require("../../config.json");

//for allowing page to access static resources, in our index.html we can use /js for all our javascript files.
app.use("/js", express.static(path.join(__dirname, "../client/js")));
app.use("/css", express.static(path.join(__dirname, "../client/css")));
app.use("/img", express.static(path.join(__dirname, "../client/img")));
app.use("/html", express.static(path.join(__dirname, "../client/html")));

/**
 * Serve index.html when the user visits the site in their browser
 */
app.get("/", function (req, res) {
  res.sendFile(path.join(__dirname, "/../client/index.html"));
});

/**
 * Start listening, I'm not sure how the details of this are working
 */
var port = process.env.PORT || config.port;
http.listen(port, function () {
  winston.log("debug", "listening on port:" + port);
});

/**
 * 2. GAME VARIABLES
 */

//import game related classes
var ClientData = require("./lib/clientData");
var util = require("./lib/util");
var QuadtreeManager = require("./lib/quadtreeManager");
var SpatialHashManager = require("./lib/spacialHashManager");
var GameLogicService = require("./lib/gameLogicService");
var Heap = require("heap");

/**
 * Quadtree will hold all of the objects in the game that will need to be kept track of
 */
var quadtreeManager = new QuadtreeManager();
var quadtree = quadtreeManager.getQuadtree();

const spatialHashManager = new SpatialHashManager();

var gameLogicService = new GameLogicService(
  quadtreeManager,
  spatialHashManager
);

gameLogicService.initializeGame();

/**
 * currentClientDatas stores references to the currentClientData objects which are inside of the on('connection') handler,
 * this is for accessing clientData outside of the context of a socket event
 */
var currentClientDatas = [];
var currentClientDatasSpectators = [];
var sockets = {};
var scoreboardList = [];
var radarObjects = {};

/**
 * 2. SOCKET CONNECTION CALLBACKS
 */

/**
 *  Here is where we attach the event handlers for the socket
 *
 * NOTE: inside the scope of this function, currentClientData will refer to
 * the client who is responsible for sending the socket event the server, meaning socket.id and currentClientData.id should be the same,
 * when accessing currentClientData from outside the context of a socket event from that client (like in the gameObjectUpdater loop),
 * use the currentClientDatas array and index it by a socket id number
 */
socketIo.on("connection", function (socket) {
  winston.log("debug", `user connected with socket id ${socket.id}`);

  /**
   * Here is where I need to perform any server-side logic to set up state for the newly connecting player.
   * For example: calculate players starting position, get their ID, etc.
   */
  var currentClientData = new ClientData(
    socket.id,
    GameLogicService.getSpawnLocation(quadtreeManager)
  );

  /**
   * 2.1 "HANDSHAKE"/MANAGEMENT RELATED SOCKET EVENTS
   */

  /**
   * Client broadcasts this init event after it has set up its socket to respond to
   * events from the server socket.
   */
  socket.on("init", function (screenName) {
    screenName = screenName.substring(0, config.screenName.maxLength);
    //only allow 10 characters for screen name
    for (var i = 0; i < config.screenName.blacklist.length; i++) {
      if (
        screenName
          .toUpperCase()
          .indexOf(config.screenName.blacklist[i].toUpperCase()) > -1
      ) {
        var splitName = screenName
          .toUpperCase()
          .split(config.screenName.blacklist[i].toUpperCase());
        screenName = splitName.join("*");
      }
    }
    currentClientData.screenName = screenName.toLowerCase();
    socket.emit("welcome", currentClientData, {
      gameWidth: config.gameWidth,
      gameHeight: config.gameHeight
    });
  });

  /**
   * Client broadcasts this event after they have received the welcome event from the server
   * They send back some information the server needs to properly manage this user
   */
  socket.on("welcome_received", function (clientUpdatedData) {
    //copy over player nested object to clientData reference for this socket
    currentClientData.player = clientUpdatedData.player || {};

    //get reference to socket so we can send updates to this client
    sockets[clientUpdatedData.id] = socket;

    //players need to go into the quadtree and the currentClientDatas array
    //spectators just go in the currentClientDatasSpectators array so their logic can be processed separately
    if (clientUpdatedData.player.type === "PLAYER") {
      currentClientDatas.push(currentClientData);
      quadtree.put(currentClientData.tank.forQuadtree());
    } else if (clientUpdatedData.player.type === "SPECTATOR") {
      currentClientDatasSpectators.push(currentClientData);
    }
  });

  /**
   * Client responded to pingcheck event,
   * calculate how long it took
   */
  socket.on("pongcheck", function () {
    currentClientData.ping =
      new Date().getTime() - currentClientData.startPingTime;
  });

  /**
   * When client calls socket.disconnect() on their end or the server calls socket.disconnect(), this event is automatically fired
   * It is important to clean up anything that was put into the quadtree for this particular client
   */
  socket.on("disconnect", function () {
    /**
     * Remove player's bullets
     * Eventually it may be better to do this somewhere else, for now this will do
     */

    for (let bullet of currentClientData.tank.bullets) {
      quadtree.remove(bullet.forQuadtree());
    }

    /**
     * Remove player from quadtree
     */
    quadtree.remove(currentClientData.tank.forQuadtree(), "id");

    if (currentClientData.player.type === "PLAYER") {
      var playerIndex = util.findIndex(
        currentClientDatas,
        currentClientData.id
      );
      if (playerIndex > -1) {
        currentClientDatas.splice(playerIndex, 1);
        winston.log(
          "debug",
          `Player ${currentClientData.player.screenName} has been removed from tracked players.`
        );
      }
    } else if (currentClientData.player.type === "SPECTATOR") {
      var spectatorIndex = util.findIndex(
        currentClientDatasSpectators,
        currentClientData.id
      );
      if (spectatorIndex > -1) {
        currentClientDatasSpectators.splice(spectatorIndex, 1);
        winston.log(
          "debug",
          `Spectator has been removed from tracked spectators.`
        );
      }
    }

    var allItemsInQuadtree = quadtree.get({
      x: 0,
      y: 0,
      w: config.gameWidth,
      h: config.gameHeight
    });
    winston.log("debug", "quadtree size", allItemsInQuadtree.length);
  });

  /**
   * 2.2 GAME RELATED SOCKET EVENTS
   */

  /**
   * This is likely where client will send their movement input
   * This is called at least once each time the client redraws the frame
   */
  socket.on("client_checkin", function (clientCheckinData) {
    if (clientCheckinData) {
      currentClientData.player.userInput = {
        keysPressed: clientCheckinData.keysPressed || config.defaultKeysPressed,
        mouseClicked:
          clientCheckinData.mouseClicked || config.defaultMouseClicked,
        mouseAngle: clientCheckinData.mouseAngle || config.defaultMouseAngle
      };
    } else {
      currentClientData.player.userInput = {
        keysPressed: config.defaultKeysPressed,
        mouseClicked: config.defaultMouseClicked,
        mouseAngle: config.defaultMouseAngle
      };
    }

    currentClientData.lastHeartbeat = new Date().getTime();
  });

  socket.on("windowResized", function (data) {
    currentClientData.player.screenWidth = data.screenWidth;
    currentClientData.player.screenHeight = data.screenHeight;
  });
});

/**
 * 3.0 GAME RELATED FUNCTIONS AND LOOPS
 */

/**
 * Check the ping for all connected clients
 */
var checkPing = function () {
  currentClientDatas.forEach(function (clientData) {
    currentClientDatas[
      util.findIndex(currentClientDatas, clientData.id)
    ].startPingTime = new Date().getTime();
    sockets[clientData.id].emit("pingcheck");
  });
};

/**
 * gameTick is called once per player on each gameObjectUpdater call
 */
var gameTick = function (clientData) {
  gameLogicService.gameTick(
    clientData,
    sockets[clientData.id],
    currentClientDatas
  );
};

var gameTickSpectator = function (clientData) {
  gameLogicService.gameTickSpectator(clientData, sockets[clientData.id]);
};

/**
 * Iterate through players and spectators and update their game objects
 */
var gameObjectUpdater = function () {
  //Iterate backwards, players or spectators may be removed from the array as the iteration occurs
  for (var i = currentClientDatas.length - 1; i >= 0; --i) {
    gameTick(currentClientDatas[i]);
  }

  for (var i = currentClientDatasSpectators.length - 1; i >= 0; --i) {
    gameTickSpectator(currentClientDatasSpectators[i]);
  }
};

/**
 * For each player send the game objects that are visible to them.
 */
var clientUpdater = function () {
  function queryAndSendData(clientData) {
    if (!sockets[clientData.id] || !clientData.player) return;

    // Xác định vị trí trung tâm để quét vùng nhìn (Camera)
    // Nếu là Player thì lấy tọa độ xe tăng, nếu là Spectator không có vị trí thì mặc định lấy tâm map (hoặc 0,0)
    var viewX = clientData.position
      ? clientData.position.x
      : config.gameWidth / 2;
    var viewY = clientData.position
      ? clientData.position.y
      : config.gameHeight / 2;

    var queryArea = {
      x: viewX - clientData.player.screenWidth / 2,
      y: viewY - clientData.player.screenHeight / 2,
      w: clientData.player.screenWidth,
      h: clientData.player.screenHeight
    };

    var perspective = {
      perspective: { x: viewX, y: viewY }
    };

    var ammo = {
      ammo: {
        capacity: config.tank.ammoCapacity,
        count: clientData.tank ? clientData.tank.ammo : 0 // Tránh crash nếu spectator không có tank
      }
    };

    var range = {
      x: viewX - clientData.player.screenWidth / 2,
      y: viewY - clientData.player.screenHeight / 2,
      width: clientData.player.screenWidth,
      height: clientData.player.screenHeight
    };

    sockets[clientData.id].emit(
      "game_objects_update",
      Object.assign(
        {},
        perspective,
        quadtreeManager.queryGameObjects(queryArea),
        spatialHashManager.queryTracks(range),
        ammo,
        { scoreboard: scoreboardList },
        { radar: radarObjects }
      )
    );
  }

  currentClientDatas.forEach(function (clientData) {
    queryAndSendData(clientData);
  });
  currentClientDatasSpectators.forEach(function (clientData) {
    queryAndSendData(clientData);
  });
};
var updateScoreboard = function () {
  if (currentClientDatas.length === 0) {
    scoreboardList = [];
    return;
  }

  // Bước 1: Lọc trùng tên - Chỉ giữ lại mạng Kills cao nhất của mỗi ScreenName
  var uniquePlayersMap = {};
  currentClientDatas.forEach(function (clientData) {
    if (clientData.tank && clientData.screenName) {
      var name = clientData.screenName;
      var kills = clientData.tank.kills || 0;

      // Nếu tên chưa có trong map, hoặc có rồi nhưng mạng cũ thấp hơn mạng mới thì cập nhật
      if (!uniquePlayersMap[name] || kills > uniquePlayersMap[name].kills) {
        uniquePlayersMap[name] = {
          screenName: name,
          kills: kills
        };
      }
    }
  });

  // Chuyển Map thành mảng các object cụ thể để tiến hành sắp xếp xếp hạng
  var uniquePlayersArray = Object.keys(uniquePlayersMap).map(function (key) {
    return uniquePlayersMap[key];
  });

  // Bước 2: Sử dụng thư viện Heap để lấy danh sách Top có Kills cao nhất từ mảng đã lọc trùng
  scoreboardList = Heap.nlargest(
    uniquePlayersArray,
    Math.min(uniquePlayersArray.length, config.scoreBoardLength),
    function (player1, player2) {
      return player1.kills - player2.kills;
    }
  );
};
var updateRadar = function () {
  radarObjects = quadtreeManager.queryGameObjectsForType(["TANK", "WALL"]);
};

/**
 * Server loops (I'm not sure what the optimal timeout is for these callbacks)
 */

//update all the game objects
setInterval(gameObjectUpdater, 1000 / 60);

//push out data to clients
setInterval(clientUpdater, 1000 / 40);

//update scoreboard
setInterval(updateScoreboard, 500);

//update radar
setInterval(updateRadar, 2500);
