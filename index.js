// index.js - Discord Casino Bot (MySQL persistence) + Roulette + Bet Selection
// Node 17 compatible via small polyfill; discord.js v14

// --- Polyfill for Node 17: Web Streams (ReadableStream/WritableStream/TransformStream) ---
(() => {
  try {
    const web = require('stream/web');
    if (web) {
      if (typeof globalThis.ReadableStream === 'undefined' && web.ReadableStream) globalThis.ReadableStream = web.ReadableStream;
      if (typeof globalThis.WritableStream === 'undefined' && web.WritableStream) globalThis.WritableStream = web.WritableStream;
      if (typeof globalThis.TransformStream === 'undefined' && web.TransformStream) globalThis.TransformStream = web.TransformStream;
    }
    if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = require('util').TextEncoder;
    if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = require('util').TextDecoder;
  } catch {}
})();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
require('dotenv').config();
const db = require('./db');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds], partials: [Partials.Channel] });

// --- State (non-persistent) ---
const bjGames = new Map();      // userId -> blackjack state
const minesGames = new Map();   // userId -> mines state
const slotsPanels = new Map();  // userId -> messageId
const dicePanels = new Map();   // userId -> messageId
const roulettePanels = new Map(); // userId -> messageId
const rouletteSelections = new Map(); // userId -> { type, number? }

const STARTING_CREDITS = 200;
const DEFAULT_BETS = { slots: 5, dice: 5, mines: 10, blackjack: 10, roulette: 10 };
const MIN_BET = 1;
const MAX_BET = 100000;

async function getBalance(userId){ return db.getUserBalance(userId, STARTING_CREDITS); }
async function setBalance(userId, amount){ return db.setUserBalance(userId, amount); }
async function addBalance(userId, delta){ return db.addUserBalance(userId, delta, STARTING_CREDITS); }

async function getBet(userId, game){ return db.getUserBet(userId, game, DEFAULT_BETS[game]); }
async function setBet(userId, game, amount){ return db.setUserBet(userId, game, amount); }

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// --- Lobby UI ---
function casinoPanel() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('casino_slots').setLabel('🎰 Slots').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('casino_blackjack').setLabel('🃏 Blackjack').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('casino_dice').setLabel('🎲 Dice').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('casino_mines').setLabel('💣 Mines').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('casino_roulette').setLabel('🎡 Roulette').setStyle(ButtonStyle.Primary),
  );
const row2 = new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('casino_balance').setLabel('💰 Balance').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId('casino_bonus').setLabel('🎁 Claim 4h Bonus').setStyle(ButtonStyle.Success),
);
  const embed = new EmbedBuilder()
    .setTitle('🏛️ Casino Lobby')
    .setDescription([
      `Welcome! Pick a game below:`,
      `• 🎰 **Slots** — per-player panel; use **Set Bet**.`,
      `• 🃏 **Blackjack** — dealer stands on 17; **Set Bet** supported.`,
      `• 🎲 **Dice** — roll 4–6 to win; **Set Bet** supported.`,
      `• 💣 **Mines** — reveal safe tiles & cash out; **Set Bet** supported.`,
      `• 🎡 **Roulette (European)** — red/black/even/odd/dozens/single; **Set Bet** and choose wager type.`,
    ].join('\n'));
  return { embed, components: [row1, row2] };
}

// =================== SLOTS (panel) ===================
const SLOT_SYMBOLS = ['🍒','🍋','🍇','🍉','🔔','⭐','7️⃣'];
function slotRandomFrame() { return [0,1,2].map(()=>SLOT_SYMBOLS[Math.floor(Math.random()*SLOT_SYMBOLS.length)]); }
function slotPayout([a,b,c]) { if (a===b && b===c) return (a==='7️⃣')?100:30; if (a===b||a===c||b===c) return 10; return 0; }
async function slotsPanelEmbed(userId) {
  const bet = await getBet(userId,'slots');
  const bal = await getBalance(userId);
  return new EmbedBuilder().setTitle('🎰 Slots').setDescription(`Press **Spin** (cost **${bet}**).`).setFooter({ text: `Balance: ${bal}` });
}
function slotsControls(ownerId, spinning=false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`slots_spin:${ownerId}`).setLabel(spinning?'Spinning...':'Spin 🎰').setStyle(ButtonStyle.Primary).setDisabled(spinning),
    new ButtonBuilder().setCustomId(`bet_set:slots:${ownerId}`).setLabel('💸 Set Bet').setStyle(ButtonStyle.Secondary).setDisabled(spinning)
  );
}
async function openSlotsPanel(interaction, userId) {
  const existing = slotsPanels.get(userId);
  if (existing) {
    try { const msg = await interaction.channel.messages.fetch(existing); await interaction.reply({ content: `Your Slots panel: ${msg.url}`, ephemeral: true }); return; } catch {}
  }
  await interaction.reply({ embeds: [await slotsPanelEmbed(userId)], components: [slotsControls(userId, false)] });
  const msg = await interaction.fetchReply();
  slotsPanels.set(userId, msg.id);
}
async function slotsSpin(interaction, ownerId) {
  if (interaction.user.id !== ownerId) { await interaction.reply({ content: "This Slots panel isn't yours.", ephemeral: true }); return; }
  const cost = await getBet(ownerId,'slots');
  const bal = await getBalance(ownerId);
  if (bal < cost) { await interaction.reply({ content: `You need **${cost}** credits. Balance: **${bal}**.`, ephemeral: true }); return; }
  await addBalance(ownerId, -cost);

  await interaction.deferUpdate();
  await interaction.message.edit({ embeds: [new EmbedBuilder().setTitle('🎰 Slots — Spinning...').setDescription('| ? | ? | ? |').setFooter({ text: `Cost: ${cost} • Balance: ${await getBalance(ownerId)}` })], components: [slotsControls(ownerId, true)] });
  for (const d of [150,200,250,300,400,500]) {
    const f = slotRandomFrame();
    await interaction.message.edit({ embeds: [new EmbedBuilder().setTitle('🎰 Slots — Spinning...').setDescription(`| ${f[0]} | ${f[1]} | ${f[2]} |`).setFooter({ text: `Cost: ${cost} • Balance: ${await getBalance(ownerId)}` })], components: [slotsControls(ownerId, true)] });
    await sleep(d);
  }
  const finalSpin = slotRandomFrame();
  const payout = slotPayout(finalSpin);
  if (payout>0) await addBalance(ownerId, payout);
  const net = payout - cost;
  const result = new EmbedBuilder()
    .setTitle('🎰 Slots — Result')
    .setDescription(`| ${finalSpin[0]} | ${finalSpin[1]} | ${finalSpin[2]} |`)
    .addFields({ name: 'Payout', value: `${payout}`, inline: true }, { name: 'Net', value: (net>=0?`+${net}`:`${net}`), inline: true }, { name: 'Balance', value: `${await getBalance(ownerId)}`, inline: true });
  await db.recordResult({ guildId: interaction.guildId, userId: ownerId, game: 'slots', result: (net>0?'win':(net<0?'loss':'push')), net: net });
  await interaction.message.edit({ embeds: [result], components: [slotsControls(ownerId, false)] });
}

// =================== BLACKJACK ===================
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function freshDeck() { const d=[]; for (const s of SUITS) for (const r of RANKS) d.push(`${r}${s}`); for (let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]];} return d; }
function handValue(cards){let t=0,a=0;for(const c of cards){const r=c.replace('♠','').replace('♥','').replace('♦','').replace('♣','');if(r==='A'){a++;t+=11}else if(['K','Q','J'].includes(r)){t+=10}else t+=parseInt(r,10);} while(t>21&&a>0){t-=10;a--} return t;}
function isBlackjack(cards){return cards.length===2 && handValue(cards)===21;}
function visibleDealer(dealer,hideHole=true){return hideHole?`${dealer[0]} | 🂠`:dealer.join(' | ');}
function bjControls(ownerId, disable=false){ return new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`bj_hit:${ownerId}`).setLabel('Hit ➕').setStyle(ButtonStyle.Primary).setDisabled(disable),
  new ButtonBuilder().setCustomId(`bj_stand:${ownerId}`).setLabel('Stand ✋').setStyle(ButtonStyle.Secondary).setDisabled(disable),
  new ButtonBuilder().setCustomId(`bet_set:blackjack:${ownerId}`).setLabel('💸 Set Bet').setStyle(ButtonStyle.Secondary).setDisabled(disable),
);}
function renderHand(userTag, player, dealer, hideHole=true){ return [`**Player (${userTag})**`, `${player.join(' | ')}  → **${handValue(player)}**`, ``, `**Dealer**`, `${visibleDealer(dealer, hideHole)}  → **${hideHole?'??':handValue(dealer)}**`].join('\n'); }
async function startBlackjack(interaction, userId){
  const bet = await getBet(userId,'blackjack');
  const bal= await getBalance(userId);
  if(bal < bet){ await interaction.reply({content:`You need **${bet}** credits. Balance: **${bal}**.`, ephemeral:true}); return; }
  await addBalance(userId, -bet);
  const deck=freshDeck(); const player=[]; const dealer=[];
  const state={ owner:userId, deck, player, dealer, bet, done:false };
  bjGames.set(userId, state);

  const dealing = new EmbedBuilder().setTitle('🃏 Blackjack — Dealing...').setDescription('Preparing the table...').addFields({name:'Bet', value:`${bet}`, inline:true},{name:'Balance', value:`${await getBalance(userId)}`, inline:true});
  await interaction.reply({ embeds:[dealing] });
  // Animated deal
  state.player.push(state.deck.pop()); await sleep(200);
  await interaction.editReply({ embeds:[ new EmbedBuilder().setTitle('🃏 Blackjack — Dealing...').setDescription(renderHand(`<@${userId}>`, state.player, state.dealer, true)).addFields({name:'Bet', value:`${state.bet}`, inline:true},{name:'Balance', value:`${await getBalance(userId)}`, inline:true}) ] });
  state.dealer.push(state.deck.pop()); await sleep(200);
  await interaction.editReply({ embeds:[ new EmbedBuilder().setTitle('🃏 Blackjack — Dealing...').setDescription(renderHand(`<@${userId}>`, state.player, state.dealer, true)).addFields({name:'Bet', value:`${state.bet}`, inline:true},{name:'Balance', value:`${await getBalance(userId)}`, inline:true}) ] });
  state.player.push(state.deck.pop()); await sleep(200);
  await interaction.editReply({ embeds:[ new EmbedBuilder().setTitle('🃏 Blackjack — Dealing...').setDescription(renderHand(`<@${userId}>`, state.player, state.dealer, true)).addFields({name:'Bet', value:`${state.bet}`, inline:true},{name:'Balance', value:`${await getBalance(userId)}`, inline:true}) ] });
  state.dealer.push(state.deck.pop()); await sleep(200);

  let content=''; let disable=false;
  if(isBlackjack(state.player)){
    if(isBlackjack(state.dealer)){ await addBalance(userId, state.bet); state.done=true; content=`**Push.** Both have Blackjack. Bet returned (+${state.bet}).`; }
    else { const win=Math.floor(bet*1.5); await addBalance(userId, state.bet + win); state.done=true; content=`**Blackjack!** You win +${win} (3:2).`; }
    disable = true;
    // stats
    const r = content.includes('Push') ? 'push' : (content.includes('Blackjack!') ? 'win' : 'loss');
    const net = content.includes('Push') ? 0 : (content.includes('Blackjack!') ? Math.floor(bet*1.5) : -state.bet);
    await db.recordResult({ guildId: interaction.guildId, userId: userId, game: 'blackjack', result: r, net });
  }
  const embed = new EmbedBuilder().setTitle(state.done?'🃏 Blackjack — Result':'🃏 Blackjack')
    .setDescription(renderHand(`<@${userId}>`, state.player, state.dealer, !state.done))
    .addFields({name:'Bet', value:`${state.bet}`, inline:true},{name:'Balance', value:`${await getBalance(userId)}`, inline:true})
    .setFooter({ text: state.done ? 'Hand finished' : 'Dealer stands on 17.' });
  await interaction.editReply({ content: content?`${content}\n\n`:undefined, embeds:[embed], components:[bjControls(userId, disable)] });
}

async function bjHit(interaction, ownerId){
  if(interaction.user.id !== ownerId){ await interaction.reply({content:"This button isn't for your hand.", ephemeral:true}); return; }
  const state = bjGames.get(ownerId); if(!state || state.done){ await interaction.reply({content:'No active hand. Open Blackjack again.', ephemeral:true}); return; }
  state.player.push(state.deck.pop());
  const pv = handValue(state.player);
  let content=''; let disable=false;
  if(pv>21){ state.done=true; content=`**Bust!** You lose ${state.bet}.`; disable=true; await db.recordResult({ guildId: interaction.guildId, userId: ownerId, game: 'blackjack', result: 'loss', net: -state.bet }); }
  const embed = new EmbedBuilder().setTitle(state.done?'🃏 Blackjack — Result':'🃏 Blackjack')
    .setDescription(renderHand(`<@${ownerId}>`, state.player, state.dealer, true))
    .addFields({name:'Bet', value:`${state.bet}`, inline:true},{name:'Balance', value:`${await getBalance(ownerId)}`, inline:true});
  await interaction.update({ content: content?`${content}\n\n`:undefined, embeds:[embed], components:[bjControls(ownerId, disable)] });
}

async function bjStand(interaction, ownerId){
  if(interaction.user.id !== ownerId){ await interaction.reply({content:"This button isn't for your hand.", ephemeral:true}); return; }
  const state = bjGames.get(ownerId); if(!state || state.done){ await interaction.reply({content:'No active hand. Open Blackjack again.', ephemeral:true}); return; }
  // Dealer plays
  while(handValue(state.dealer)<17){ state.dealer.push(state.deck.pop()); await sleep(150); }
  const pv = handValue(state.player); const dv = handValue(state.dealer);
  let outcome='';
  if(dv>21 || pv>dv){ await addBalance(ownerId, state.bet * 2); outcome=`**You win!** +${state.bet}.`; }
  else if(pv===dv){ await addBalance(ownerId, state.bet); outcome=`**Push.** Bet returned (+${state.bet}).`; }
  else { outcome=`**Dealer wins.** You lose ${state.bet}.`; }
  state.done=true;
  const embed = new EmbedBuilder().setTitle('🃏 Blackjack — Result')
    .setDescription(renderHand(`<@${ownerId}>`, state.player, state.dealer, false))
    .addFields({name:'Bet', value:`${state.bet}`, inline:true},{name:'Balance', value:`${await getBalance(ownerId)}`, inline:true});
  const resType = outcome.includes('win') ? 'win' : (outcome.includes('Push') ? 'push' : 'loss');
  const net = outcome.includes('win') ? state.bet : (outcome.includes('Push') ? 0 : -state.bet);
  await db.recordResult({ guildId: interaction.guildId, userId: ownerId, game: 'blackjack', result: resType, net });
  await interaction.update({ content: `${outcome}\n\n`, embeds:[embed], components:[bjControls(ownerId, true)] });
}

// =================== DICE (panel) ===================
const DICE = ['⚀','⚁','⚂','⚃','⚄','⚅'];
async function dicePanelEmbed(userId){ const b=await getBet(userId,'dice'); const bal=await getBalance(userId); return new EmbedBuilder().setTitle('🎲 Dice').setDescription(`Press **Roll** (bet **${b}**, 4–6 wins double).`).setFooter({ text:`Balance: ${bal}` }); }
function diceControls(ownerId, rolling=false){ return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dice_roll:${ownerId}`).setLabel(rolling?'Rolling...':'Roll 🎲').setStyle(ButtonStyle.Secondary).setDisabled(rolling), new ButtonBuilder().setCustomId(`bet_set:dice:${ownerId}`).setLabel('💸 Set Bet').setStyle(ButtonStyle.Secondary).setDisabled(rolling)); }
async function openDicePanel(interaction, userId){
  const existing = dicePanels.get(userId);
  if(existing){ try{ const msg=await interaction.channel.messages.fetch(existing); await interaction.reply({content:`Your Dice panel: ${msg.url}`, ephemeral:true}); return; } catch {} }
  await interaction.reply({ embeds:[await dicePanelEmbed(userId)], components:[diceControls(userId,false)] });
  const msg=await interaction.fetchReply(); dicePanels.set(userId, msg.id);
}
async function diceRoll(interaction, ownerId){
  if(interaction.user.id !== ownerId){ await interaction.reply({content:"This Dice panel isn't yours.", ephemeral:true}); return; }
  const bet=await getBet(ownerId,'dice'); const bal=await getBalance(ownerId); if(bal < bet){ await interaction.reply({content:`You need **${bet}** credits. Balance: **${bal}**.`, ephemeral:true}); return; }
  await addBalance(ownerId, -bet);
  await interaction.deferUpdate();
  for (const ms of [150,200,250,300,400,500]){
    const f = DICE[Math.floor(Math.random()*6)];
    await interaction.message.edit({ embeds:[ new EmbedBuilder().setTitle('🎲 Dice — Rolling...').setDescription(f).setFooter({ text:`Bet: ${bet} • Balance: ${await getBalance(ownerId)}` }) ], components:[diceControls(ownerId, true)] });
    await sleep(ms);
  }
  const roll = 1 + Math.floor(Math.random()*6);
  const sym = DICE[roll-1];
  let payout = 0; if (roll>=4) payout = bet*2;
  if (payout>0) await addBalance(ownerId, payout);
  const net = payout - bet;
  const result = new EmbedBuilder().setTitle('🎲 Dice — Result').setDescription(`${sym} → **${roll}**`).addFields(
    {name:'Payout', value:`${payout}`, inline:true},
    {name:'Net', value:(net>=0?`+${net}`:`${net}`), inline:true},
    {name:'Balance', value:`${await getBalance(ownerId)}`, inline:true}
  );
  await db.recordResult({ guildId: interaction.guildId, userId: ownerId, game: 'dice', result: (net>0?'win':(net<0?'loss':'push')), net });
  await interaction.message.edit({ embeds:[result], components:[diceControls(ownerId,false)] });
}

// =================== MINES ===================
const MINES_ROWS=4, MINES_COLS=5, MINES_COUNT=5, MINES_HOUSE_EDGE=0.04;
function minesIndex(r,c){return r*MINES_COLS+c;}
function minesNewBoard(){ const total=MINES_ROWS*MINES_COLS; const set=new Set(); while(set.size<MINES_COUNT){ set.add(Math.floor(Math.random()*total)); } return set; }
function minesState(owner, bet){ return { owner, bet, revealed:new Set(), mines:minesNewBoard(), alive:true, safeRevealed:0, multiplier:1.0, totalTiles:MINES_ROWS*MINES_COLS, totalSafe:MINES_ROWS*MINES_COLS-MINES_COUNT }; }
function minesControls(ownerId, enableCash, enableForfeit){ return new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`mines_cashout:${ownerId}`).setLabel('💰 Cashout').setStyle(ButtonStyle.Success).setDisabled(!enableCash),
  new ButtonBuilder().setCustomId(`mines_forfeit:${ownerId}`).setLabel('🏳️ Forfeit').setStyle(ButtonStyle.Secondary).setDisabled(!enableForfeit),
  new ButtonBuilder().setCustomId(`bet_set:mines:${ownerId}`).setLabel('💸 Set Bet').setStyle(ButtonStyle.Secondary).setDisabled(!enableForfeit),
);}
function minesGridComponents(state, revealAll=false){
  const rows=[];
  for(let r=0;r<MINES_ROWS;r++){
    const row=new ActionRowBuilder();
    for(let c=0;c<MINES_COLS;c++){
      const idx=minesIndex(r,c); const isRev=state.revealed.has(idx); const isMine=state.mines.has(idx);
      let label='❔', style=ButtonStyle.Secondary, disabled=false;
      if(revealAll){ if(isMine){label='💣'; style=ButtonStyle.Danger; disabled=true;} else if(isRev){label='🟩'; style=ButtonStyle.Success; disabled=true;} else {label='⬜'; disabled=true;} }
      else { if(isRev){ label='🟩'; style=ButtonStyle.Success; disabled=true; } else { label='❔'; disabled=!state.alive; } }
      row.addComponents(new ButtonBuilder().setCustomId(`mines_click:${state.owner}:${idx}`).setLabel(label).setStyle(style).setDisabled(disabled));
    }
    rows.push(row);
  }
  return rows;
}
function minesEmbed(state, finished=false, busted=false, cashed=0){
  const potential = Math.floor(state.bet * state.multiplier);
  const fields=[ {name:'Bet', value:`${state.bet}`, inline:true},{name:'Multiplier', value:`x${state.multiplier.toFixed(2)}`, inline:true},{name:'Potential Cashout', value:`${potential}`, inline:true} ];
  const title = finished ? (busted?'💥 Mines — BOOM!':'💰 Mines — Cashed Out') : '💣 Mines';
  const desc = finished ? (busted?'You hit a mine and lost your bet.':`You cashed out **${cashed}**.`) : `Pick safe tiles to grow your cashout. Cash out anytime.\nGrid: ${MINES_ROWS}×${MINES_COLS}, Mines: ${MINES_COUNT}`;
  return new EmbedBuilder().setTitle(title).setDescription(desc).addFields(fields);
}
function minesUpdateMultiplier(state){
  const revealedTotal=state.revealed.size;
  const safeRevealed=state.safeRevealed;
  const cellsLeftBefore=state.totalTiles - revealedTotal;
  const safeLeftBefore=state.totalSafe - safeRevealed;
  if(cellsLeftBefore<=0 || safeLeftBefore<=0) return;
  const step=(cellsLeftBefore/safeLeftBefore)*(1 - MINES_HOUSE_EDGE);
  state.multiplier *= step;
}
async function startMines(interaction, userId){
  const bet = await getBet(userId,'mines'); const bal=await getBalance(userId);
  if(bal < bet){ await interaction.reply({content:`You need **${bet}** credits to play Mines. Balance: **${bal}**.`, ephemeral:true}); return; }
  await addBalance(userId, -bet);
  const state=minesState(userId, bet); minesGames.set(userId, state);
  await interaction.reply({ embeds:[minesEmbed(state,false)], components:[...minesGridComponents(state,false), minesControls(userId,true,true)] });
}
async function minesClick(interaction, ownerId, idx){
  if(interaction.user.id !== ownerId){ await interaction.reply({content:"This board isn't yours.", ephemeral:true}); return; }
  const state=minesGames.get(ownerId); if(!state || !state.alive){ await interaction.reply({content:'No active Mines game.', ephemeral:true}); return; }
  if(state.revealed.has(idx)){ await interaction.reply({content:'That tile is already revealed.', ephemeral:true}); return; }
  if(state.mines.has(idx)){
    state.alive=false;
    await db.recordResult({ guildId: interaction.guildId, userId: ownerId, game: 'mines', result: 'loss', net: -state.bet });
    await interaction.update({ embeds:[minesEmbed(state,true,true,0)], components:[...minesGridComponents(state,true), minesControls(ownerId,false,false)] });
    return;
  }
  state.revealed.add(idx); state.safeRevealed += 1; minesUpdateMultiplier(state);
  await interaction.update({ embeds:[minesEmbed(state,false)], components:[...minesGridComponents(state,false), minesControls(ownerId,true,true)] });
}
async function minesCashout(interaction, ownerId){
  if(interaction.user.id !== ownerId){ await interaction.reply({content:"This board isn't yours.", ephemeral:true}); return; }
  const state=minesGames.get(ownerId); if(!state || !state.alive){ await interaction.reply({content:'No active Mines game to cash out.', ephemeral:true}); return; }
  const amount=Math.max(0, Math.floor(state.bet * state.multiplier));
  await addBalance(ownerId, amount);
  state.alive=false;
  await db.recordResult({ guildId: interaction.guildId, userId: ownerId, game: 'mines', result: (amount>state.bet?'win':(amount===state.bet?'push':'loss')), net: amount - state.bet });
  await interaction.update({ embeds:[minesEmbed(state,true,false,amount)], components:[...minesGridComponents(state,true), minesControls(ownerId,false,false)] });
}
async function minesForfeit(interaction, ownerId){
  if(interaction.user.id !== ownerId){ await interaction.reply({content:"This board isn't yours.", ephemeral:true}); return; }
  const state=minesGames.get(ownerId); if(!state || !state.alive){ await interaction.reply({content:'No active Mines game to forfeit.', ephemeral:true}); return; }
  state.alive=false;
  await db.recordResult({ guildId: interaction.guildId, userId: ownerId, game: 'mines', result: 'loss', net: -state.bet });
    await interaction.update({ embeds:[minesEmbed(state,true,true,0)], components:[...minesGridComponents(state,true), minesControls(ownerId,false,false)] });
}

// =================== ROULETTE (panel) ===================
const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
async function roulettePanelEmbed(userId){
  const sel = rouletteSelections.get(userId) || { type:'red' };
  const bet = await getBet(userId,'roulette');
  const bal = await getBalance(userId);
  let choice = sel.type;
  if (sel.type==='single') choice = `single (${sel.number ?? '—'})`;
  return new EmbedBuilder().setTitle('🎡 Roulette (European)').setDescription(`Pick a bet and **Spin**. Bet: **${bet}**`).addFields({name:'Your Bet', value: `${choice}`, inline:true},{name:'Balance', value: `${bal}`, inline:true});
}
function rouletteSelect(ownerId, curType){
  const menu = new StringSelectMenuBuilder().setCustomId(`roulette_pick:${ownerId}`).setPlaceholder('Choose bet type').addOptions(
    { label:'Red (1:1)', value:'red', default: curType==='red' },
    { label:'Black (1:1)', value:'black', default: curType==='black' },
    { label:'Even (1:1)', value:'even', default: curType==='even' },
    { label:'Odd (1:1)', value:'odd', default: curType==='odd' },
    { label:'Low 1–18 (1:1)', value:'low', default: curType==='low' },
    { label:'High 19–36 (1:1)', value:'high', default: curType==='high' },
    { label:'1st 12 (2:1)', value:'dz1', default: curType==='dz1' },
    { label:'2nd 12 (2:1)', value:'dz2', default: curType==='dz2' },
    { label:'3rd 12 (2:1)', value:'dz3', default: curType==='dz3' },
    { label:'Single number (35:1)', value:'single', default: curType==='single' },
  );
  return new ActionRowBuilder().addComponents(menu);
}
function rouletteControls(ownerId, spinning=false, singleSelected=false){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`roulette_spin:${ownerId}`).setLabel(spinning?'Spinning...':'Spin 🎡').setStyle(ButtonStyle.Primary).setDisabled(spinning),
    new ButtonBuilder().setCustomId(`bet_set:roulette:${ownerId}`).setLabel('💸 Set Bet').setStyle(ButtonStyle.Secondary).setDisabled(spinning),
    new ButtonBuilder().setCustomId(`roulette_setnum:${ownerId}`).setLabel('Choose #️⃣').setStyle(ButtonStyle.Secondary).setDisabled(spinning || !singleSelected),
  );
}
async function openRoulettePanel(interaction, userId){
  const existing = roulettePanels.get(userId);
  if(existing){ try{ const msg=await interaction.channel.messages.fetch(existing); await interaction.reply({content:`Your Roulette panel: ${msg.url}`, ephemeral:true}); return; } catch {} }
  rouletteSelections.set(userId, { type:'red' });
  await interaction.reply({ embeds:[await roulettePanelEmbed(userId)], components:[ rouletteSelect(userId,'red'), rouletteControls(userId,false,false) ] });
  const msg=await interaction.fetchReply(); roulettePanels.set(userId, msg.id);
}
function rouletteWin(number, sel){
  if (sel.type==='single') return number === sel.number ? 35 : 0;
  if (number === 0) return 0;
  if (sel.type==='red') return REDS.has(number) ? 1 : 0;
  if (sel.type==='black') return !REDS.has(number) ? 1 : 0;
  if (sel.type==='even') return number % 2 === 0 ? 1 : 0;
  if (sel.type==='odd') return number % 2 === 1 ? 1 : 0;
  if (sel.type==='low') return number >=1 && number <=18 ? 1 : 0;
  if (sel.type==='high') return number >=19 && number <=36 ? 1 : 0;
  if (sel.type==='dz1') return (number>=1 && number<=12) ? 2 : 0;
  if (sel.type==='dz2') return (number>=13 && number<=24) ? 2 : 0;
  if (sel.type==='dz3') return (number>=25 && number<=36) ? 2 : 0;
  return 0;
}
async function rouletteSpin(interaction, ownerId){
  if (interaction.user.id !== ownerId){ await interaction.reply({content:"This Roulette panel isn't yours.", ephemeral:true}); return; }
  const sel = rouletteSelections.get(ownerId) || { type:'red' };
  if (sel.type==='single' && (typeof sel.number !== 'number' || sel.number<0 || sel.number>36)){
    await interaction.reply({ content:'Choose a number (0–36) first.', ephemeral:true }); return;
  }
  const bet = await getBet(ownerId,'roulette');
  const bal = await getBalance(ownerId);
  if (bal < bet){ await interaction.reply({ content:`You need **${bet}** credits. Balance: **${bal}**.`, ephemeral:true }); return; }
  await addBalance(ownerId, -bet);

  await interaction.deferUpdate();
  for (const ms of [120,140,160,200,240,300,360,420]){
    const n = Math.floor(Math.random()*37);
    const color = (n===0) ? '🟩' : (REDS.has(n) ? '🟥' : '⬛');
    await interaction.message.edit({ embeds:[ new EmbedBuilder().setTitle('🎡 Roulette — Spinning...').setDescription(`${color} **${n}**`).addFields({name:'Bet', value:`${bet}`, inline:true},{name:'Balance', value:`${await getBalance(ownerId)}`, inline:true}) ], components:[ rouletteSelect(ownerId, sel.type), rouletteControls(ownerId,true, sel.type==='single') ] });
    await sleep(ms);
  }
  const number = Math.floor(Math.random()*37);
  const color = (number===0) ? '🟩' : (REDS.has(number) ? '🟥' : '⬛');
  const multiplier = rouletteWin(number, sel);
  const payout = bet * (multiplier + (multiplier>0?1:0));
  if (multiplier>0) await addBalance(ownerId, payout);
  const net = payout - bet;
  const choiceTxt = sel.type==='single' ? `single (${sel.number})` : sel.type;
  const result = new EmbedBuilder().setTitle('🎡 Roulette — Result')
    .setDescription(`${color} **${number}**`)
    .addFields({name:'Your Bet', value: choiceTxt, inline:true},
               {name:'Payout', value: `${multiplier>0 ? payout : 0}`, inline:true},
               {name:'Net', value: multiplier>0 ? `+${net}` : `-${bet}`, inline:true},
               {name:'Balance', value: `${await getBalance(ownerId)}`, inline:true});
  await db.recordResult({ guildId: interaction.guildId, userId: ownerId, game: 'roulette', result: (net>0?'win':(net<0?'loss':'push')), net });
  await interaction.message.edit({ embeds:[result], components:[ rouletteSelect(ownerId, sel.type), rouletteControls(ownerId,false, sel.type==='single') ] });
}

// ---- Bet modal helpers ----
function openBetModal(interaction, game, ownerId){
  const modal = new ModalBuilder().setTitle('Set Bet Amount').setCustomId(`bet_modal:${game}:${ownerId}`);
  const input = new TextInputBuilder().setCustomId('bet_amount').setLabel('Enter amount (1 - 100000)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g., 25');
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

// ---- Command registration ----
async function ensureCommands(){
  const commands=[
	new SlashCommandBuilder().setName('bonus').setDescription('Claim your 4h bonus (50 credits).'),
    new SlashCommandBuilder().setName('casino').setDescription('Open the casino lobby.'),
    new SlashCommandBuilder().setName('balance').setDescription('Check your credits.'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Show leaderboards for this server')
      .addStringOption(o=>o.setName('type').setDescription('balance | wins | losses | winrate | net').setRequired(true).addChoices(
        {name:'balance', value:'balance'},{name:'wins', value:'wins'},{name:'losses', value:'losses'},{name:'winrate', value:'winrate'},{name:'net', value:'net'}
      ))
      .addStringOption(o=>o.setName('game').setDescription('game for stats').addChoices(
        {name:'all', value:'all'},{name:'slots', value:'slots'},{name:'blackjack', value:'blackjack'},{name:'dice', value:'dice'},{name:'mines', value:'mines'},{name:'roulette', value:'roulette'}
      )),
    new SlashCommandBuilder().setName('give').setDescription('Give credits to another user.')
      .addUserOption(opt=>opt.setName('user').setDescription('User to give credits to').setRequired(true))
      .addIntegerOption(opt=>opt.setName('amount').setDescription('Amount of credits').setMinValue(1).setRequired(true)),
  ].map(c=>c.toJSON());
  const rest = new REST({ version:'10' }).setToken(TOKEN);
  try{
    const guildIds=[...client.guilds.cache.keys()];
    for(const gid of guildIds){ await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: commands }); }
    console.log(`Registered slash commands to ${guildIds.length} guild(s).`);
  }catch(err){ console.error('Failed to register commands:', err); }
}

client.once('ready', async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  try { await db.init(); console.log('MySQL ready.'); } catch (e) { console.error('DB init failed:', e); }
  await ensureCommands();
});

client.on('interactionCreate', async (interaction)=>{
  // Slash commands
  if (interaction.isChatInputCommand()){
    const userId = interaction.user.id;
    if (interaction.commandName === 'bonus') {
  const res = await db.claimBonus(interaction.user.id, 50);
  const ts = Math.floor(res.nextAt / 1000);
  await interaction.reply({
    content: res.ok
      ? `🎁 You claimed **50**! Next bonus <t:${ts}:R>.`
      : `⏳ Bonus not ready. Claim <t:${ts}:R>.`,
    ephemeral: true
  });
  return;
}
    if (interaction.commandName === 'leaderboard'){
      if (!interaction.guildId){ await interaction.reply({ content:'Leaderboards are server-only.', ephemeral:true }); return; }
      const type = interaction.options.getString('type', true);
      const game = interaction.options.getString('game') || 'all';
      if (type === 'balance'){
        const rows = await db.lbBalance(interaction.guildId, 10);
        if (!rows.length){ await interaction.reply({ content:'No data yet.', ephemeral:true }); return; }
        const lines = await Promise.all(rows.map(async (r, i)=>`${i+1}. <@${r.user_id}> — **${r.balance}**`));
        const embed = new EmbedBuilder().setTitle('🏆 Balance Leaderboard').setDescription(lines.join('\n')).setFooter({ text: `Server: ${interaction.guild?.name || interaction.guildId}` });
        await interaction.reply({ embeds:[embed] });
        return;
      } else {
        const rows = await db.lbStats(interaction.guildId, game, type, 10);
        if (!rows.length){ await interaction.reply({ content:'No data yet.', ephemeral:true }); return; }
        const lines = rows.map((r,i)=>{
          const plays = (r.wins||0)+(r.losses||0);
          const wr = plays ? (100*r.wins/plays).toFixed(1) : '0.0';
          const metricVal = (type==='wins')? r.wins : (type==='losses')? r.losses : (type==='net')? r.net : `${wr}%`;
          return `${i+1}. <@${r.user_id}> — **${metricVal}**`;
        });
        const title = `🏆 ${type.upper ? type.upper() : type.charAt(0).toUpperCase()+type.slice(1)} Leaderboard ${game!=='all'?`(${game})`:''}`;
        const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join('\n')).setFooter({ text: `Server: ${interaction.guild?.name || interaction.guildId}` });
        await interaction.reply({ embeds:[embed] });
        return;
      }
    }

    if (interaction.commandName === 'balance'){ const bal = await getBalance(userId); await interaction.reply({ content:`You have **${bal}** credits.`, ephemeral:true }); return; }
    if (interaction.commandName === 'give'){
      const target = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      const fromBal = await getBalance(userId);
      if (amount > fromBal){ await interaction.reply({ content:`You don't have enough credits to give ${amount}. Your balance: **${fromBal}**.`, ephemeral:true }); return; }
      await addBalance(userId, -amount);
      await addBalance(target.id, amount);
      await interaction.reply({ content:`You gave **${amount}** credits to ${target}. Your new balance: **${await getBalance(userId)}**.` }); return;
    }
    if (interaction.commandName === 'casino'){ const { embed, components } = casinoPanel(); await interaction.reply({ embeds:[embed], components }); return; }
  }

  // Buttons
  if (interaction.isButton()){
    const userId = interaction.user.id;
    const id = interaction.customId;
if (id === 'casino_bonus') {
  const res = await db.claimBonus(userId, 50);
  const ts = Math.floor(res.nextAt / 1000);
  await interaction.reply({
    content: res.ok
      ? `🎁 Claimed **50**! Next bonus <t:${ts}:R>.`
      : `⏳ Not yet! Claim <t:${ts}:R>.`,
    ephemeral: true
  });
  return;
}
    if (id === 'casino_balance'){ const bal = await getBalance(userId); await interaction.reply({ content:`Your balance: **${bal}**`, ephemeral:true }); return; }
    if (id === 'casino_slots'){ await openSlotsPanel(interaction, userId); return; }
    if (id === 'casino_dice'){ await openDicePanel(interaction, userId); return; }
    if (id === 'casino_blackjack'){ await startBlackjack(interaction, userId); return; }
    if (id === 'casino_mines'){ await startMines(interaction, userId); return; }
    if (id === 'casino_roulette'){ await openRoulettePanel(interaction, userId); return; }

    if (id.startsWith('slots_spin:')){ const ownerId = id.split(':')[1]; await slotsSpin(interaction, ownerId); return; }
    if (id.startsWith('dice_roll:')){ const ownerId = id.split(':')[1]; await diceRoll(interaction, ownerId); return; }

    if (id.startsWith('bj_hit:')){ const ownerId = id.split(':')[1]; await bjHit(interaction, ownerId); return; }
    if (id.startsWith('bj_stand:')){ const ownerId = id.split(':')[1]; await bjStand(interaction, ownerId); return; }

    if (id.startsWith('mines_click:')){ const [_, ownerId, idxStr] = id.split(':'); await minesClick(interaction, ownerId, parseInt(idxStr,10)); return; }
    if (id.startsWith('mines_cashout:')){ const ownerId = id.split(':')[1]; await minesCashout(interaction, ownerId); return; }
    if (id.startsWith('mines_forfeit:')){ const ownerId = id.split(':')[1]; await minesForfeit(interaction, ownerId); return; }

    if (id.startsWith('roulette_spin:')){ const ownerId = id.split(':')[1]; await rouletteSpin(interaction, ownerId); return; }
    if (id.startsWith('roulette_setnum:')){
      const ownerId = id.split(':')[1];
      const sel = rouletteSelections.get(ownerId) || { type:'red' };
      if (interaction.user.id !== ownerId){ await interaction.reply({ content:"This panel isn't yours.", ephemeral:true }); return; }
      if (sel.type !== 'single'){ await interaction.reply({ content:"Select 'Single number' first.", ephemeral:true }); return; }
      return openBetModal(interaction, 'roulette_number', ownerId);
    }

    // Bet modal openers
    if (id.startsWith('bet_set:')){
      const [_, game, ownerId] = id.split(':');
      if (interaction.user.id !== ownerId){ await interaction.reply({ content:"This panel isn't yours.", ephemeral:true }); return; }
      return openBetModal(interaction, game, ownerId);
    }
  }

  // Select menus
  if (interaction.isStringSelectMenu()){
    const id = interaction.customId;
    if (id.startsWith('roulette_pick:')){
      const ownerId = id.split(':')[1];
      if (interaction.user.id !== ownerId){ await interaction.reply({ content:"This panel isn't yours.", ephemeral:true }); return; }
      const choice = interaction.values[0];
      const cur = rouletteSelections.get(ownerId) || { type:'red' };
      const next = { type: choice, number: (choice==='single'?cur.number:undefined) };
      rouletteSelections.set(ownerId, next);
      await interaction.update({ embeds:[await roulettePanelEmbed(ownerId)], components:[ rouletteSelect(ownerId, choice), rouletteControls(ownerId,false, choice==='single') ] });
      return;
    }
  }

  // Bet modals submit
  if (interaction.isModalSubmit()){
    const id = interaction.customId;
    if (id.startsWith('bet_modal:')){
      const [_, game, ownerId] = id.split(':');
      if (interaction.user.id !== ownerId){ await interaction.reply({ content:"This panel isn't yours.", ephemeral:true }); return; }
      const raw = interaction.fields.getTextInputValue('bet_amount').trim();
      const amt = parseInt(raw, 10);
      if (isNaN(amt) || amt < MIN_BET || amt > MAX_BET){ await interaction.reply({ content:`Enter a whole number between ${MIN_BET} and ${MAX_BET}.`, ephemeral:true }); return; }

      if (game === 'roulette_number'){
        if (amt < 0 || amt > 36){ await interaction.reply({ content:'Number must be 0–36.', ephemeral:true }); return; }
        const sel = rouletteSelections.get(ownerId) || { type:'single' };
        sel.type = 'single'; sel.number = amt; rouletteSelections.set(ownerId, sel);
        await interaction.reply({ content:`Number set to **${amt}**.`, ephemeral:true });
        try{
          const msgId = roulettePanels.get(ownerId);
          const msg = await interaction.channel.messages.fetch(msgId);
          await msg.edit({ embeds:[await roulettePanelEmbed(ownerId)], components:[ rouletteSelect(ownerId, 'single'), rouletteControls(ownerId,false,true) ] });
        }catch{}
        return;
      }

      await setBet(ownerId, game, amt);
      await interaction.reply({ content:`Set **${game}** bet to **${amt}**.`, ephemeral:true });

      async function refresh(idMap, builderFn){
        try{
          const msgId = idMap.get(ownerId); if(!msgId) return;
          const msg = await interaction.channel.messages.fetch(msgId);
          await msg.edit(await builderFn());
        }catch{}
      }
      if (game==='slots') await refresh(slotsPanels, async ()=>({ embeds:[await slotsPanelEmbed(ownerId)], components:[slotsControls(ownerId,false)] }));
      if (game==='dice') await refresh(dicePanels, async ()=>({ embeds:[await dicePanelEmbed(ownerId)], components:[diceControls(ownerId,false)] }));
      if (game==='roulette') await refresh(roulettePanels, async ()=>({ embeds:[await roulettePanelEmbed(ownerId)], components:[ rouletteSelect(ownerId, (rouletteSelections.get(ownerId)||{type:'red'}).type), rouletteControls(ownerId,false, (rouletteSelections.get(ownerId)||{type:'red'}).type==='single') ] }));
      return;
    }
  }
});


// ---- Console admin (grant credits) ----
// Use: grant <userId> <amount> <ADMIN_SECRET>
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt('casino> ');
rl.prompt();
rl.on('line', async (line) => {
  try {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    if (cmd === 'grant' || cmd === 'give') {
      if (!ADMIN_SECRET) { console.log('Set ADMIN_SECRET in .env to use console admin.'); rl.prompt(); return; }
      const userId = parts[1];
      const amount = parseInt(parts[2], 10);
      const secret = parts[3];
      if (!userId || isNaN(amount) || !secret) { console.log('Usage: grant <userId> <amount> <ADMIN_SECRET>'); rl.prompt(); return; }
      if (secret !== ADMIN_SECRET) { console.log('Invalid admin secret.'); rl.prompt(); return; }
      const newBal = await db.addUserBalance(userId, amount);
      console.log(`Granted ${amount} to ${userId}. New balance: ${newBal}`);
    } else if (cmd === 'help') {
      console.log('Commands: grant <userId> <amount> <ADMIN_SECRET>, help, exit');
    } else if (cmd === 'exit' || cmd === 'quit') {
      process.exit(0);
    } else if (cmd.length) {
      console.log('Unknown command. Type "help".');
    }
  } catch (e) {
    console.error('Command error:', e);
  } finally {
    rl.prompt();
  }
});

client.login(TOKEN);
