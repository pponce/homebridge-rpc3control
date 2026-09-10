import type { API, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';
import type { OutletConfig } from './config.js';
import { PduController } from './controller.js';
import { safeError, writeLog } from './errors.js';
import { PowerAwareReboot } from './reboot.js';
import { VERSION } from './settings.js';

export class OutletAccessory {
  private service: Service;
  private api: API;
  private log: Logging;
  private controller: PduController;
  private outlet: OutletConfig;
  private reboot?: PowerAwareReboot;
  private unsubscribe?: () => void;

  constructor(api: API, log: Logging, accessory: PlatformAccessory, controller: PduController, outlet: OutletConfig) {
    this.api = api;
    this.log = log;
    this.controller = controller;
    this.outlet = outlet;
    const { Service, Characteristic } = api.hap;
    accessory.displayName = outlet.name;
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'BayTech')
      .setCharacteristic(Characteristic.Model, 'RPC PDU')
      .setCharacteristic(Characteristic.SerialNumber, `${controller.config.id}-${outlet.number}-${outlet.mode}`)
      .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
    this.service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, outlet.name);
    this.service.setCharacteristic(Characteristic.Name, outlet.name);
    this.service.setCharacteristic(Characteristic.ConfiguredName, outlet.name);
    const on = this.service.getCharacteristic(Characteristic.On);
    on.onGet(() => this.getOn()).onSet(value => this.setOn(value));
    if (outlet.mode === 'reboot') {
      this.reboot = new PowerAwareReboot(
        controller, outlet.number, outlet.resetAfterMs,
        () => { this.service.updateCharacteristic(Characteristic.On, this.communicationError()); },
        message => this.log.error(`[${controller.config.name}] Outlet ${outlet.number}: ${message}`),
        (level, message) => this.message(level, message),
      );
    }
    this.service.updateCharacteristic(Characteristic.On, this.communicationError());
    this.unsubscribe = controller.subscribe(status => {
      const entry = status?.get(outlet.number);
      if (entry) {
        this.reboot?.observe(entry.on);
        this.service.updateCharacteristic(Characteristic.On, entry.on);
      } else this.service.updateCharacteristic(Characteristic.On, this.communicationError());
    });
  }

  private communicationError(): Error {
    const hap = this.api.hap;
    return new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private message(level: 'info' | 'warn' | 'debug', text: string): void {
    writeLog(message => this.log[level](message), `[${this.controller.config.name}] Outlet ${this.outlet.number} (${this.outlet.name}): ${text}`);
  }

  async getOn(): Promise<boolean> {
    this.message('debug', 'HomeKit state read requested.');
    try {
      const on = await this.controller.getOutlet(this.outlet.number, 'HomeKit');
      this.reboot?.observe(on);
      this.message('debug', `HomeKit state read returned ${on ? 'On' : 'Off'}.`);
      return on;
    } catch (error) {
      this.message('debug', `HomeKit state read failed: ${safeError(error)}`);
      throw this.communicationError();
    }
  }

  async setOn(value: CharacteristicValue): Promise<void> {
    if (typeof value !== 'boolean' && value !== 0 && value !== 1) {
      const hap = this.api.hap;
      throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const requested = value ? 'On' : 'Off';
    try {
      if (this.reboot) {
        const sent = await this.reboot.set(Boolean(value));
        if (!sent) this.message('info', `HomeKit ${requested} request: already ${requested}; no power command needed.`);
        else this.message('info', `HomeKit ${requested} request: ${value ? 'On command accepted by PDU' : 'native Reboot command accepted by PDU; PDU controls the off/on cycle'}.`);
      } else {
        await this.controller.command(this.outlet.number, value ? 'on' : 'off');
        this.message('info', `HomeKit ${requested} request: ${requested} command accepted by PDU.`);
      }
    } catch (error) {
      this.message('warn', `HomeKit ${requested} request failed or could not be confirmed: ${safeError(error)}`);
      throw this.communicationError();
    }
  }

  dispose(): void { this.unsubscribe?.(); this.reboot?.stop(); }
}
