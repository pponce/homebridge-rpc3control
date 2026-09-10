import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { OutletAccessory } from './accessory.js';
import { accessoryKey, parseConfig } from './config.js';
import { PduController } from './controller.js';
import { safeError } from './errors.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class Rpc3Platform implements DynamicPlatformPlugin {
  private api: API;
  private log: Logging;
  private config: PlatformConfig;
  private cached = new Map<string, PlatformAccessory>();
  private controllers: PduController[] = [];
  private handlers: OutletAccessory[] = [];

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.api = api;
    this.log = log;
    this.config = config;
    api.on('didFinishLaunching', () => this.launch());
    api.on('shutdown', () => this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void { this.cached.set(accessory.UUID, accessory); }

  private launch(): void {
    let pdus;
    try { pdus = parseConfig(this.config.pdus); }
    catch (error) {
      this.log.error(`RPC PDU configuration rejected: ${safeError(error)}`);
      // Preserve cached accessories, but never expose stale values or accept writes.
      for (const accessory of this.cached.values()) {
        const on = accessory.getService(this.api.hap.Service.Switch)?.getCharacteristic(this.api.hap.Characteristic.On);
        const fail = () => { throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); };
        on?.onGet(fail).onSet(fail);
      }
      return;
    }
    const wanted = new Set<string>();
    for (const [index, pdu] of pdus.entries()) {
      const controller = new PduController(pdu);
      this.controllers.push(controller);
      controller.subscribe((_status, error) => {
        if (error) this.log.warn(`[${pdu.name}] ${safeError(error)}`);
      });
      for (const outlet of pdu.outlets) {
        const uuid = this.api.hap.uuid.generate(accessoryKey(pdu.id, outlet));
        wanted.add(uuid);
        const restored = this.cached.get(uuid);
        const accessory = restored ?? new this.api.platformAccessory(outlet.name, uuid);
        // Store only identity; Homebridge persists accessory context to disk.
        accessory.context = { pduId: pdu.id, outletNumber: outlet.number, mode: outlet.mode };
        this.handlers.push(new OutletAccessory(this.api, this.log, accessory, controller, outlet));
        if (restored) this.api.updatePlatformAccessories([accessory]);
        else this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      controller.startPolling(index * 250);
    }
    for (const [uuid, accessory] of this.cached) {
      if (!wanted.has(uuid)) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.log.info(`Configured ${pdus.length} PDU(s) and ${wanted.size} outlet switch(es).`);
  }

  private shutdown(): void {
    for (const handler of this.handlers) handler.dispose();
    for (const controller of this.controllers) controller.stop();
  }
}
