import * as os from "os";
import path from "path";
import chalk from "chalk";
import fs from "fs";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import baileys, { delay } from "@whiskeysockets/baileys";
import { plugins } from "./lib/plugins.js";
import { scraper } from "../storage/scraper/index.js";
// Utility function to check if a value is a number
const isNumber = (x) => typeof x === "number" && !isNaN(x);

// Initialize the database
const database = new (await import("./lib/database.js")).default();

global.plugins = plugins;
global.scraper = scraper;

import { translate } from "@vitalets/google-translate-api";

export async function handler(conn, m, chatUpdate, store) {
  conn.msgqueue = conn.msgqueue || [];
  global.store = store;
  if (!m || typeof m !== "object") return;

  try {
    // Ensure database is loaded properly
    await database.load(m, db);
  } catch (e) {
    conn.logger.error("Database loader Error: ", e);
  }

  try {
    m.exp = 0;
    m.limit = false;

    // Check if user is premium
    const isPrems = m.isOwner || db.data.users[m.sender]?.premium || false;

    // Handle message queue based on settings and user permissions
    if (db.data.settings.queue && m.body && !isPrems) {
      let queue = conn.msgqueue,
        time = 1000 * 5;
      let previousID = queue[queue.length - 1];

      queue.push(m.id || m.key.id);
      setInterval(async () => {
        if (queue.indexOf(previousID) === -1) clearInterval(conn);
        await delay(time);
      }, time);
    }

    // Assign experience points
    m.exp += Math.ceil(Math.random() * 10);
    let user = db.data.users && db.data.users[m.sender];

    // Loop through plugins and execute based on conditions
    for (let name in plugins) {
      let plugin = plugins[name];

      if (!plugin) continue;
      if (plugin.disabled) continue;

      try {
        // Execute 'all' function of the plugin if defined
        if (typeof plugin.all === "function") {
          await plugin.all.call(conn, m, { chatUpdate });
        }

        // Execute 'before' function of the plugin if defined
        if (typeof plugin.before === "function") {
          if (await plugin.before.call(conn, m, { chatUpdate })) continue;
        }

        // Check if message is a command and matches plugin's command
        if (m.prefix) {
          let { args, text } = m;
          let isCommand = (m.prefix && m.body.startsWith(m.prefix)) || false;
          const command = isCommand ? m.command.toLowerCase() : false;

          let isAccept = Array.isArray(plugin.command)
            ? plugin.command.some((cmd) => cmd === command)
            : false;

          m.plugin = name;
          if (!isAccept) continue;

          // Check chat and user settings for restrictions
          if (m.chat in db.data.chats || m.sender in db.data.users) {
            if (!m.isOwner && db.data.chats[m.chat]?.isBanned) return;
            if (!m.isOwner && db.data.users[m.sender]?.banned) return;
          }

          // Check plugin specific permissions
          if (plugin.owner && !m.isOwner) {
            m.reply("owner");
            continue;
          }

          if (plugin.premium && !isPrems) {
            m.reply("premium");
            continue;
          }

          if (plugin.group && !m.isGroup) {
            m.reply("group");
            continue;
          }

          if (plugin.botAdmin && !m.isBotAdmin) {
            m.reply("botAdmin");
            continue;
          }

          if (plugin.admin && !m.isAdmin) {
            m.reply("admin");
            continue;
          }

          if (plugin.private && m.isGroup) {
            m.reply("private");
            continue;
          }

          if (plugin.register && (!user || !user.registered)) {
            m.reply("register");
            continue;
          }

          if (plugin.quoted && !m.isQuoted) {
            m.reply("quoted");
            continue;
          }

          // Handle XP and limit
          m.isCommand = true;
          let xp = "exp" in plugin ? parseInt(plugin.exp) : 3;

          if (xp < 200) m.exp += xp;
          if (plugin.loading) m.reply("wait");

          // Check if plugin has limit and enforce it
          if (!isPrems && plugin.limit && user.limit < plugin.limit * 1) {
            m.reply("limit");
            continue;
          }

          // Replace placeholders in example message
          if (plugin.example && !text) {
            m.reply(
              plugin.example
                .replace(/%p/gi, m.prefix)
                .replace(/%cmd/gi, m.command)
                .replace(/%text/gi, text),
            );
            continue;
          }

          let extra = {
            conn,
            args,
            isPrems,
            command,
            text,
            chatUpdate,
            store,
          };

          try {
            await plugin.run(m, extra);
            if (!isPrems) m.limit = m.limit || plugin.limit || false;
          } catch (e) {
            console.error(e);
            m.reply(func.format(e));
          } finally {
            // Execute 'after' function of the plugin if defined
            if (typeof plugin.after === "function") {
              try {
                await plugin.after.call(conn, m, extra);
              } catch (e) {
                console.error(e);
              }
            }
          }
        }
      } catch (e) {
        console.error(e);
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    if (m.isGroup) {
      //auto typing / record
      if (db.data.chats[m.chat].presence)
        await this.sendPresenceUpdate(
          ["composing", "recording"].getRandom(),
          m.chat,
        );
    }
    if (db.data.settings.queue && m.body) {
      const id = m.id;
      this.msgqueque.unqueue(id);
    }
    // console.log(db.data.users[m.sender])
    let user,
      stats = db.data.stats;
    if (m) {
      if (m.sender && (user = db.data.users[m.sender])) {
        user.exp += m.exp;
        user.limit -= m.limit * 1;
        // console.log(m.limit * 1)
      }

      let stat;
      if (m.plugin) {
        let now = +new Date();
        if (m.plugin in stats) {
          stat = stats[m.plugin];
          if (!isNumber(stat.total)) stat.total = 1;
          if (!isNumber(stat.success)) stat.success = m.error != null ? 0 : 1;
          if (!isNumber(stat.last)) stat.last = now;
          if (!isNumber(stat.lastSuccess))
            stat.lastSuccess = m.error != null ? 0 : now;
        } else
          stat = stats[m.plugin] = {
            total: 1,
            success: m.error != null ? 0 : 1,
            last: now,
            lastSuccess: m.error != null ? 0 : now,
          };
        stat.total += 1;
        stat.last = now;
        if (m.error == null) {
          stat.success += 1;
          stat.lastSuccess = now;
        }
      }
    }

    // Log the command execution
    if (!m.isBaileys && !m.fromMe) {
      console.log(
        "~> [\x1b[1;32m CMD \x1b[1;37m]",
        chalk.yellow(m.type),
        "from",
        chalk.green(m.pushName),
        "in",
        chalk.cyan(m.isGroup ? m.metadata.subject : "private chat"),
        "args :",
        chalk.green(m.body?.length || 0),
      );
    }
  }
}

export async function participantsUpdate({ id, participants, action }) {
  if (db.data.settings.self) return;

  let chat = db.data.chats[id] || {},
    ppuser;
  let metadata = await conn.groupMetadata(id);

  switch (action) {
    case "add":
    case "remove":
      if (chat.welcome) {
        for (let user of participants) {
          try {
            ppuser = await conn.profilePictureUrl(user, "image");
          } catch {
            ppuser =
              "https://i0.wp.com/www.gambarunik.id/wp-content/uploads/2019/06/Top-Gambar-Foto-Profil-Kosong-Lucu-Tergokil-.jpg";
          } finally {
            let tekswell = `Halo @${
              user.split("@")[0]
            } 👋\n\nSelamat datang di grup ${
              metadata.subject
            }! Kami senang kamu bergabung dengan kami.\n\nSaya harap kamu betah disini dan jangan lupa untuk selalu mengikuti peraturan yang ada`;
            let teksbye = `Selamat tinggal @${
              user.split("@")[0]
            } 👋\n\nSalam perpisahan, kami harap kamu baik-baik saja disana`;

            if (action == "add") {
              conn.sendMessage(id, {
                image: { url: ppuser },
                contextInfo: { mentionedJid: [user] },
                caption: tekswell,
                mentions: [user],
              });
            } else if (action == "remove") {
              conn.sendMessage(id, { text: teksbye, mentions: [user] });
            }
          }
        }
      }
      break;
    case "promote":
    case "demote":
      let tekspro = `Selamat @${
        participants[0].split("@")[0]
      } atas kenaikan pangkatnya di grup ${metadata.subject} 🥂`;
      let teksdem = `Sabar yaa @${
        participants[0].split("@")[0]
      } atas penurunan pangkatnya di grup ${metadata.subject} 😔`;

      if (chat.detect) {
        if (action == "promote")
          conn.sendMessage(id, { text: tekspro, mentions: [participants[0]] });
        if (action == "demote")
          conn.sendMessage(id, { text: teksdem, mentions: [participants[0]] });
      }
      break;
  }
}

export async function groupsUpdate(groupsUpdate) {
  if (db.data.settings.self) return;
  for (let groupUpdate of groupsUpdate) {
    let id = groupUpdate.id;
    let chats = db.data.chats[id] || {},
      text = "";

    if (!chats.detect) continue;
    if (groupUpdate.desc)
      text = "*Deskripsi grup telah diubah menjadi*\n\n@desc".replace(
        "@desc",
        groupUpdate.desc,
      );
    if (groupUpdate.subject)
      text = "*Judul grup telah diubah menjadi*\n\n@subject".replace(
        "@subject",
        groupUpdate.subject,
      );
    if (groupUpdate.icon) text = "*Ikon grup telah diubah*";
    if (groupUpdate.inviteCode)
      text =
        "*Tautan grup telah diubah menjadi*\n\nhttps://chat.whatsapp.com/@revoke".replace(
          "@revoke",
          groupUpdate.inviteCode,
        );
    if (groupUpdate.announce === true) text = "*Grup telah ditutup*";
    if (groupUpdate.announce === false) text = "*Grup telah dibuka*";
    if (groupUpdate.restrict === true)
      text = "*Grup dibatasi hanya untuk peserta saja*";
    if (groupUpdate.restrict === false)
      text = "*Grup ini dibatasi hanya untuk admin saja*";

    conn.sendMessage(id, { text });
  }
}

export async function deleteUpdate({ fromMe, id, participants }) {
  try {
    if (fromMe) return;
    let msg = conn.serializeM(conn.loadMessage(id));
    if (!msg) return;
    if (db.data.chats[m.chat].antidelete) return;

    conn.sendMessage(
      msg.key.remoteJid,
      {
        text: `[❗] Terdeteksi @${
          participants[0].split("@")[0]
        } telah menghapus pesan.\n\nUntuk mematikan fitur ini, ketik *.off antidelete*\nUntuk menghapus pesan yang dikirim oleh BOT, balas pesan dengan perintah *.delete*`,
        mentions: [participants[0]],
      },
      { quoted: msg },
    );
    conn.copyNForward(m.chat, msg, false);
  } catch (e) {
    console.error(e);
  }
}

export async function presenceUpdate(presenceUpdate) {
  const id = presenceUpdate.id;
  const nouser = Object.keys(presenceUpdate.presences);
  const status = presenceUpdate.presences[nouser]?.lastKnownPresence;
  const user = db.data.users[nouser[0]];

  if (user?.afk && status === "composing" && user.afk > -1) {
    if (user.banned) {
      user.afk = -1;
      user.afkReason = "User Banned AFK";
      return;
    }

    const username = nouser[0].split("@")[0];
    const timeAfk = new Date() - user.afk;
    const caption = `@${username} berhenti afk, dia sedang mengetik\n\nAlasan: ${
      user.afkReason ? user.afkReason : "tidak ada alasan"
    }\nSelama: ${timeAfk.toTimeString()} yang lalu`;

    conn.sendMessage(id, { text: caption });
    user.afk = -1;
    user.afkReason = "";
  }
}

export async function rejectCall(json) {
  if (db.data.settings.anticall) {
    for (let id of json) {
      if (id.status === "offer") {
        let msg = await conn.sendMessage(id.from, {
          text: "Maaf untuk saat ini, Kami tidak dapat menerima panggilan, entah dalam group atau pribadi\n\nJika Membutuhkan bantuan ataupun request fitur silahkan chat owner",
        });

        conn.sendContact(id.from, global.owner, msg);
        await conn.rejectCall(id.id, id.from);
      }
    }
  }
}

let file = fileURLToPath(import.meta.url);

fs.watchFile(file, () => {
  fs.unwatchFile(file);
  console.log(`Update ${file}`);
  import(file);
});
