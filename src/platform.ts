import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { OutletAccessory } from './accessory.js';
import { accessoryKey, parseConfig } from './config.js';
import { PduController } from './controller.js';
import { reportError } from './errors.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class Rpc3Platform implements DynamicPlatformPlugin {
  private api: API;
  private log: Logging;
  private config: PlatformConfig;
  private cached = new Map<string, PlatformAccessory>();
  private controllers: PduController[] = [];
  private handlers: OutletAccessory[] = [];
  private activeAccessories = new Set<PlatformAccessory>();
  private started = false;
  private stopped = false;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.api = api;
    this.log = log;
    this.config = config;
    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void { this.cached.set(accessory.UUID, accessory); }

  private report(context: string, error: unknown): void {
    reportError(message => this.log.error(message), context, error);
  }

  private start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    try { this.launch(); }
    catch (error) {
      this.report('RPC PDU startup failed', error);
      this.shutdown();
      this.markUnavailable();
    }
  }

  private markUnavailable(): void {
    const hap = this.api.hap;
    for (const accessory of new Set([...this.cached.values(), ...this.activeAccessories])) {
      try {
        const service = accessory.getService(hap.Service.Switch);
        const on = service?.getCharacteristic(hap.Characteristic.On);
        const fail = () => { throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); };
        on?.onGet(fail).onSet(fail);
        service?.updateCharacteristic(hap.Characteristic.On, new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      } catch (error) { this.report('Could not mark an RPC outlet unavailable', error); }
    }
  }

  private launch(): void {
    let pdus;
    try { pdus = parseConfig(this.config.pdus); }
    catch (error) {
      this.report('RPC PDU configuration rejected', error);
      // Preserve cached accessories, but never expose stale values or accept writes.
      this.markUnavailable();
      return;
    }
    const wanted = new Set<string>();
    for (const pdu of pdus) {
      const controller = new PduController(pdu, undefined, message => this.log.error(`[${pdu.name}] ${message}`));
      this.controllers.push(controller);
      controller.subscribe((_status, error) => {
        if (error) this.report(`[${pdu.name}] PDU operation failed`, error);
      });
      for (const outlet of pdu.outlets) {
        const uuid = this.api.hap.uuid.generate(accessoryKey(pdu.id, outlet));
        wanted.add(uuid);
        const restored = this.cached.get(uuid);
        const accessory = restored ?? new this.api.platformAccessory(outlet.name, uuid);
        this.activeAccessories.add(accessory);
        // Store only identity; Homebridge persists accessory context to disk.
        accessory.context = { pduId: pdu.id, outletNumber: outlet.number, mode: outlet.mode };
        this.handlers.push(new OutletAccessory(this.api, this.log, accessory, controller, outlet));
        if (restored) this.api.updatePlatformAccessories([accessory]);
        else this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
    for (const [uuid, accessory] of this.cached) {
      if (!wanted.has(uuid)) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.log.info(`Configured ${pdus.length} PDU(s) and ${wanted.size} outlet switch(es).`);
    // Start network work only after all accessory setup has succeeded.
    for (const [index, controller] of this.controllers.entries()) controller.startPolling(index * 250);
  }

  private shutdown(): void {
    this.stopped = true;
    for (const controller of this.controllers.splice(0)) {
      try { controller.stop(); } catch (error) { this.report('RPC PDU cleanup failed', error); }
    }
    for (const handler of this.handlers.splice(0)) {
      try { handler.dispose(); } catch (error) { this.report('RPC outlet cleanup failed', error); }
    }
  }
}
