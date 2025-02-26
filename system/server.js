import express from "express";
import path from "path";
import { createServer } from "http";
import { Server } from "socket.io";
import { toBuffer } from "qrcode";
import Helper from "./lib/helper.js";

function connect(conn, PORT) {
  let app = (global.app = express());
  let server = (global.server = createServer(app));
  let _qr = "invalid";

  conn.ev.on("connection.update", function appQR({ qr }) {
    if (qr) _qr = qr;
  });

  app.use(async (req, res) => {
    res.setHeader("content-type", "image/png");
    res.end(await toBuffer(_qr));
  });
  app.use(
    express.static(path.join(Helper.__dirname(import.meta.url), "views")),
  );

  let io = new Server(server);
  io.on("connection", (socket) => {
    let { unpipeEmit } = pipeEmit(conn, socket, "conn-");
    socket.once("disconnect", unpipeEmit);
  });

  server.listen(PORT, () => {
    console.log("App listened on port", PORT);
    if (opts["keepalive"]) keepAlive();
  });
}

function pipeEmit(event, event2, prefix = "") {
  let old = event.emit;
  event.emit = function (event, ...args) {
    old.emit(event, ...args);
    event2.emit(prefix + event, ...args);
  };
  return {
    unpipeEmit() {
      event.emit = old;
    },
  };
}

function keepAlive() {
  const url = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
  if (/(\/\/|\.)undefined\./.test(url)) return;
  setInterval(
    () => {
      fetch(url).catch(console.error);
    },
    5 * 1000 * 60,
  );
}

export default connect;
