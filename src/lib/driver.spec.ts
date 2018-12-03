import 'mocha'
import sinon from 'sinon'
import { expect } from 'chai'
import { silence } from './log'
import { botUser, mockUser } from '../utils/config'
import * as api from './api'
import * as utils from '../utils/testing'
import * as driver from './driver'
import * as methodCache from './methodCache'
import { Socket } from './ddp'

// const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let clock
let tId
let pId
const tName = utils.testChannelName
const pName = utils.testPrivateName

silence() // suppress log during tests (disable this while developing tests)

describe('driver', () => {
  before(async () => {
    const testChannel = await utils.channelInfo({ roomName: tName })
    tId = testChannel.channel._id
    const testPrivate = await utils.privateInfo({ roomName: pName })
    pId = testPrivate.group._id
  })
  after(async () => {
    await api.logout()
    await driver.logout()
    await driver.disconnect()
  })
  describe('.connect', () => {
    context('with localhost connection', () => {
      it('without args, returns a promise', () => {
        const promise = driver.connect()
        expect(promise.then).to.be.a('function')
        promise.catch((err) => console.error(err))
        return promise
      })
      it('accepts an error-first callback, providing socket', (done) => {
        driver.connect({}, (err, socket) => {
          expect(err).to.equal(null)
          expect(socket).to.be.an('object')
          done()
        })
      })
      it('without url takes localhost as default', (done) => {
        driver.connect({}, (err, socket) => {
          expect(err).to.eql(null)
          expect(socket.host).to.contain('localhost:3000')
          done()
        })
      })
      it('promise resolves with socket in successful state', () => {
        return driver.connect().then((socket) => {
          const isActive = (socket.connection.readyState === 1)
          expect(isActive).to.equal(true)
        })
      })
      it('provides the socket instance to method cache', () => {
        return driver.connect().then((socket) => {
          expect(methodCache.instance).to.eql(socket)
        })
      })
    })
    context('with timeout, on expiry', () => {
      before(() => clock = sinon.useFakeTimers(0))
      after(() => clock.restore())
      it('with url, attempts connection at URL', (done) => {
        driver.connect({ host: 'localhost:9999', timeout: 100 }, (err, socket) => {
          expect(err).to.be.an('error')
          expect(socket.config.host).to.contain('localhost:9999')
          done()
        }).catch(() => null)
        clock.tick(200)
      })
      it('returns error', (done) => {
        let opts = { host: 'localhost:9999', timeout: 100 }
        driver.connect(opts, (err, socket: Socket) => {
          expect(err).to.be.an('error')
          expect(!!socket.connected).to.eql(false)
          done()
        }).catch(() => null)
        clock.tick(200)
      })
      it('without callback, triggers promise catch', () => {
        const promise = driver.connect({ host: 'localhost:9999', timeout: 100 })
        .catch((err) => expect(err).to.be.an('error'))
        clock.tick(200)
        return promise
      })
      it('with callback, provides error to callback', (done) => {
        driver.connect({ host: 'localhost:9999', timeout: 100 }, (err) => {
          expect(err).to.be.an('error')
          done()
        }).catch(() => null)
        clock.tick(200)
      })
    })
  })
  describe('.login', () => {
    afterEach(() => driver.logout())
    it('sets the bot user status to online', async () => {
      await driver.login()
      const result = await utils.userInfo(botUser.username)
      expect(result.user.status).to.equal('online')
    })
  })
  describe('.subscribeToMessages', () => {
    it('resolves with subscription object', async () => {
      await driver.login()
      const subscription = await driver.subscribeToMessages()
      expect(subscription).to.include.keys(['id', 'name', 'unsubscribe', 'onEvent'])
    })
    after(() => driver.unsubscribeAll())
  })
  describe('.reactToMessages', () => {
    before(() => driver.login())
    afterEach(() => driver.unsubscribeAll())
    it('calls callback on every subscription update', async () => {
      const callback = sinon.spy()
      driver.reactToMessages(callback)
      await utils.sendFromUser({ text: 'SDK test `reactToMessages` 1' })
      await utils.sendFromUser({ text: 'SDK test `reactToMessages` 2' })
      expect(callback.callCount).to.equal(2)
    })
    it('calls callback with sent message object', async () => {
      const callback = sinon.spy()
      driver.reactToMessages(callback)
      await utils.sendFromUser({ text: 'SDK test `reactToMessages` 3' })
      const messageArgs = callback.getCall(0).args
      expect(messageArgs[1].msg).to.equal('SDK test `reactToMessages` 3')
    })
  })
  describe('.setupMethodCache', () => {
    beforeEach(() => methodCache.resetAll())
    // @todo needs better testing (maybe use `getServerInfo` as test call without requiring login/connect)
    // stub instance class to make sure it's only calling on instance first time, instead of hacky timers
    it('returns subsequent cached method results from cache', async () => {
      await driver.login() // calls setupMethodCache with DDP once connected
      const now = Date.now()
      const liveId = await driver.callMethod('getRoomNameById', 'GENERAL')
      const after = Date.now()
      const cacheId = await driver.callMethod('getRoomNameById', 'GENERAL')
      const final = Date.now()
      const firstCall = after - now
      const cacheCall = final - after
      expect(liveId).to.equal(cacheId)
      expect(firstCall).to.be.gt(cacheCall)
      expect(cacheCall).to.be.lte(10)
    })
  })
  describe('.sendMessage', () => {
    before(() => driver.login())
    it('sends a custom message', async () => {
      const message = driver.prepareMessage({
        rid: tId,
        msg: ':point_down:',
        emoji: ':point_right:',
        reactions: { ':thumbsup:': { usernames: [botUser.username] } },
        groupable: false
      })
      await driver.sendMessage(message)
      const last = (await utils.lastMessages(tId))[0]
      expect(last).to.have.deep.property('reactions', message.reactions)
      expect(last).to.have.property('emoji', ':point_right:')
      expect(last).to.have.property('msg', ':point_down:')
    })
    it('sends a message with actions', async () => {
      const attachments = [{
        actions: [
          { type: 'button', text: 'Action 1', msg: 'Testing Action 1', msg_in_chat_window: true },
          { type: 'button', text: 'Action 2', msg: 'Testing Action 2', msg_in_chat_window: true }
        ]
      }]
      await driver.sendMessage({
        rid: tId,
        msg: 'SDK test `prepareMessage` actions',
        attachments
      })
      const last = (await utils.lastMessages(tId))[0]
      expect(last.attachments[0].actions).to.eql(attachments[0].actions)
    })
  })
  describe('.editMessage', () => {
    before(() => driver.login())
    it('edits the last sent message', async () => {
      const original = driver.prepareMessage({
        msg: ':point_down:',
        emoji: ':point_right:',
        groupable: false,
        rid: tId
      })
      await driver.sendMessage(original)
      const sent = (await utils.lastMessages(tId))[0]
      const update = Object.assign({}, original, {
        _id: sent._id,
        msg: ':point_up:'
      })
      await driver.editMessage(update)
      const last = (await utils.lastMessages(tId))[0]
      expect(last).to.have.property('msg', ':point_up:')
      expect(last).to.have.deep.property('editedBy', {
        _id: driver.user.login.id, username: botUser.username
      })
    })
  })
  describe('.sendToRoomId', () => {
    before(() => driver.login())
    it('sends string to the given room id', async () => {
      const result = await driver.sendToRoomId('SDK test `sendToRoomId`', tId)
      expect(result).to.include.all.keys(['msg', 'rid', '_id'])
    })
    it('sends array of strings to the given room id', async () => {
      const result = await driver.sendToRoomId([
        'SDK test `sendToRoomId` A',
        'SDK test `sendToRoomId` B'
      ], tId)
      expect(result).to.be.an('array')
      expect(result[0]).to.include.all.keys(['msg', 'rid', '_id'])
      expect(result[1]).to.include.all.keys(['msg', 'rid', '_id'])
    })
  })
  describe('.sendToRoom', () => {
    before(() => driver.login())
    it('sends string to the given room name', async () => {
      await driver.subscribeToMessages()
      const result = await driver.sendToRoom('SDK test `sendToRoom`', tName)
      expect(result).to.include.all.keys(['msg', 'rid', '_id'])
    })
    it('sends array of strings to the given room name', async () => {
      await driver.subscribeToMessages()
      const result = await driver.sendToRoom([
        'SDK test `sendToRoom` A',
        'SDK test `sendToRoom` B'
      ], tName)
      expect(result).to.be.an('array')
      expect(result[0]).to.include.all.keys(['msg', 'rid', '_id'])
      expect(result[1]).to.include.all.keys(['msg', 'rid', '_id'])
    })
  })
  describe('.sendDirectToUser', () => {
    before(() => driver.login())
    it('sends string to the given room name', async () => {
      await driver.connect()
      await driver.login()
      const result = await driver.sendDirectToUser('SDK test `sendDirectToUser`', mockUser.username)
      expect(result).to.include.all.keys(['msg', 'rid', '_id'])
    })
    it('sends array of strings to the given room name', async () => {
      const result = await driver.sendDirectToUser([
        'SDK test `sendDirectToUser` A',
        'SDK test `sendDirectToUser` B'
      ], mockUser.username)
      expect(result).to.be.an('array')
      expect(result[0]).to.include.all.keys(['msg', 'rid', '_id'])
      expect(result[1]).to.include.all.keys(['msg', 'rid', '_id'])
    })
  })
  describe('.setReaction', () => {
    before(() => driver.login())
    it('adds emoji reaction to message', async () => {
      let sent = await driver.sendToRoomId('test reactions', tId)
      if (Array.isArray(sent)) sent = sent[0] // see todo on `sendToRoomId`
      await driver.setReaction(':thumbsup:', sent._id)
      const last = (await utils.lastMessages(tId))[0]
      expect(last.reactions).to.have.deep.property(':thumbsup:', {
        usernames: [ botUser.username ]
      })
    })
    it('removes if used when emoji reaction exists', async () => {
      const sent = await driver.sendMessage(driver.prepareMessage({
        msg: 'test reactions -',
        reactions: { ':thumbsup:': { usernames: [botUser.username] } },
        rid: tId
      }))
      await driver.setReaction(':thumbsup:', sent._id)
      const last = (await utils.lastMessages(tId))[0]
      expect(last).to.not.have.property('reactions')
    })
  })
  describe('.respondToMessages', () => {
    before(() => driver.login())
    beforeEach(() => driver.leaveRooms(['general', tName]))
    it('joins rooms if not already joined', async () => {
      expect(driver.joinedIds).to.have.lengthOf(0)
      await driver.respondToMessages(() => null, { rooms: ['general', tName] })
      expect(driver.joinedIds).to.have.lengthOf(2)
    })
    it('ignores messages sent from bot', async () => {
      const callback = sinon.spy()
      await driver.respondToMessages(callback)
      await driver.sendToRoomId('SDK test `respondToMessages`', tId)
      sinon.assert.notCalled(callback)
    })
    it('ignores messages in un-joined rooms', async () => {
      const callback = sinon.spy()
      await driver.respondToMessages(callback, { rooms: ['general'] })
      await utils.sendFromUser({ text: 'SDK test `respondToMessages` 1' })
      sinon.assert.notCalled(callback)
    })
    it('fires callback on messages in joined rooms', async () => {
      const callback = sinon.spy()
      await driver.respondToMessages(callback, { rooms: [tName] })
      await utils.sendFromUser({ text: 'SDK test `respondToMessages` 1' })
      sinon.assert.calledOnce(callback)
    })
    it('by default ignores edited messages', async () => {
      const callback = sinon.spy()
      const sentMessage = await utils.sendFromUser({
        text: 'SDK test `respondToMessages` sent'
      })
      driver.respondToMessages(callback, { rooms: [tName] })
      await utils.updateFromUser({
        roomId: tId,
        msgId: sentMessage.message._id,
        text: 'SDK test `respondToMessages` edited'
      })
      sinon.assert.notCalled(callback)
    })
    it('ignores edited messages, after receiving original', async () => {
      const callback = sinon.spy()
      await driver.respondToMessages(callback, { rooms: [tName] })
      const sentMessage = await utils.sendFromUser({
        text: 'SDK test `respondToMessages` sent'
      })
      await utils.updateFromUser({
        roomId: tId,
        msgId: sentMessage.message._id,
        text: 'SDK test `respondToMessages` edited'
      })
      sinon.assert.calledOnce(callback)
    })
    it('fires callback on edited message if configured', async () => {
      const callback = sinon.spy()
      const sentMessage = await utils.sendFromUser({
        text: 'SDK test `respondToMessages` sent'
      })
      await driver.respondToMessages(callback, { edited: true, rooms: [tName] })
      await utils.updateFromUser({
        roomId: tId,
        msgId: sentMessage.message._id,
        text: 'SDK test `respondToMessages` edited'
      })
      sinon.assert.calledOnce(callback)
    })
    it('by default ignores DMs', async () => {
      const dmResult = await utils.setupDirectFromUser()
      const callback = sinon.spy()
      await driver.respondToMessages(callback, { rooms: [tName] })
      await utils.sendFromUser({
        text: 'SDK test `respondToMessages` DM',
        roomId: dmResult.room._id
      })
      sinon.assert.notCalled(callback)
    })
    it('fires callback on DMs if configured', async () => {
      const dmResult = await utils.setupDirectFromUser()
      const callback = sinon.spy()
      await driver.respondToMessages(callback, { dm: true, rooms: [tName] })
      await utils.sendFromUser({
        text: 'SDK test `respondToMessages` DM',
        roomId: dmResult.room._id
      })
      sinon.assert.calledOnce(callback)
    })
    it('fires callback on ul (user leave) message types', async () => {
      const callback = sinon.spy()
      await driver.respondToMessages(callback, { rooms: [tName] })
      await utils.leaveUser()
      sinon.assert.calledWithMatch(callback, null, sinon.match({ t: 'ul' }))
      await utils.inviteUser()
    })
    it('fires callback on au (user added) message types', async () => {
      await utils.leaveUser()
      const callback = sinon.spy()
      await driver.respondToMessages(callback, { rooms: [tName] })
      await utils.inviteUser()
      sinon.assert.calledWithMatch(callback, null, sinon.match({ t: 'au' }))
    })
    it('appends room name to event meta in channels', async () => {
      const callback = sinon.spy()
      await driver.respondToMessages(callback, { dm: true, rooms: [tName] })
      await utils.sendFromUser({ text: 'SDK test `respondToMessages` DM' })
      expect(callback.firstCall.args[2].roomName).to.equal(tName)
    })
    it('room name is undefined in direct messages', async () => {
      const dmResult = await utils.setupDirectFromUser()
      const callback = sinon.spy()
      await driver.respondToMessages(callback, { dm: true, rooms: [tName] })
      await utils.sendFromUser({
        text: 'SDK test `respondToMessages` DM',
        roomId: dmResult.room._id
      })
      expect(callback.firstCall.args[2].roomName).to.equal(undefined)
    })
  })
  describe('.getRoomId', () => {
    before(() => driver.login())
    it('returns the ID for a channel by ID', async () => {
      const room = await driver.getRoomId(tName)
      expect(room).to.equal(tId)
    })
    it('returns the ID for a private room name', async () => {
      const room = await driver.getRoomId(pName)
      expect(room).to.equal(pId)
    })
  })
  describe('.getRoomName', () => {
    before(() => driver.login())
    it('returns the name for a channel by ID', async () => {
      const room = await driver.getRoomName(tId)
      expect(room).to.equal(tName)
    })
    it('returns the name for a private group by ID', async () => {
      const room = await driver.getRoomName(pId)
      expect(room).to.equal(pName)
    })
    it('returns undefined for a DM room', async () => {
      const dmResult = await utils.setupDirectFromUser()
      const room = await driver.getRoomName(dmResult.room._id)
      expect(room).to.equal(undefined)
    })
  })
  describe('.joinRooms', () => {
    before(() => driver.login())
    it('joins all the rooms in array, keeping IDs', async () => {
      driver.joinedIds.splice(0, driver.joinedIds.length) // clear const array
      await driver.joinRooms(['general', tName])
      expect(driver.joinedIds).to.have.members(['GENERAL', tId])
    })
  })
})
