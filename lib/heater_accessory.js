const BaseAccessory = require('./base_accessory')

let Accessory;
let Service;
let Characteristic;

const DEFAULT_LEVEL_COUNT = 3;

class HeaterAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    ({ Accessory, Characteristic, Service } = platform.api.hap);
    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Accessory.Categories.AIR_HEATER,
      Service.HeaterCooler
    );

    this.statusArr = deviceConfig.status;
    this.functionArr = deviceConfig.functions ? deviceConfig.functions : [];

    // get speed level dp range
    this.level_count = this.getLevelFunction("level")
    this.speed_coefficient = 100 / this.level_count

    // get TempSet dp range
    this.temp_set_range = this.getTempSetDPRange()

    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    this.isRefresh = isRefresh;

    for (const statusMap of statusArr) {
      // Active (on/off)
      if (statusMap.code === 'switch') {
        this.switchMap = statusMap;
        const hbSwitch = this.tuyaParamToHomeBridge(Characteristic.Active, this.switchMap);
        this.normalAsync(Characteristic.Active, hbSwitch);
        this.normalAsync(Characteristic.CurrentHeaterCoolerState, 2); // INACTIVE = 2
        this.normalAsync(Characteristic.TargetHeaterCoolerState, 1, {
          validValues: [Characteristic.TargetHeaterCoolerState.HEAT]
        });
      }

      // Current temperature
      if (statusMap.code === 'water_temp' || statusMap.code === 'temp_current_f') {
        this.temperatureMap = statusMap;
        this.normalAsync(Characteristic.CurrentTemperature, statusMap.value, {
          minValue: -20,
          maxValue: 122,
          minStep: 1
        });

        const hbUnits = this.tuyaParamToHomeBridge(Characteristic.TemperatureDisplayUnits, statusMap);
        this.normalAsync(Characteristic.TemperatureDisplayUnits, hbUnits, {
          minValue: hbUnits,
          maxValue: hbUnits,
          validValues: [hbUnits]
        });
      }

      // Lock
      if (statusMap.code === 'lock') {
        this.lockMap = statusMap;
        const hbLock = this.tuyaParamToHomeBridge(Characteristic.LockPhysicalControls, this.lockMap);
        this.normalAsync(Characteristic.LockPhysicalControls, hbLock);
      }

      // Speed / level (optional)
      if (statusMap.code === 'level') {
        this.speedMap = statusMap;
        const hbSpeed = this.tuyaParamToHomeBridge(Characteristic.RotationSpeed, this.speedMap);
        this.normalAsync(Characteristic.RotationSpeed, hbSpeed);
      }

      // **Target Temperature** (replace HeatingThresholdTemperature)
      if (statusMap.code === 'set_water_temp' || statusMap.code === 'temp_set_f') {
        this.tempsetMap = statusMap;
      
        // Determine min/max range
        const tempRange = this.temp_set_range || 
          (statusMap.code === 'set_water_temp' ? { min: 30, max: 70 } : { min: 86, max: 158 });
      
        // Get characteristic
        const heatChar = this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature);
      
        // 1️⃣ Set props immediately
        heatChar.setProps({
          minValue: tempRange.min,
          maxValue: tempRange.max,
          minStep: 1
        });
      
        // 2️⃣ Initialize value
        this.setCachedState(Characteristic.HeatingThresholdTemperature, statusMap.value);
        heatChar.updateValue(statusMap.value);
      
        // 3️⃣ Attach get/set handlers
        heatChar
          .on('get', callback => {
            callback(null, this.getCachedState(Characteristic.HeatingThresholdTemperature));
          })
          .on('set', (value, callback) => {
            const param = this.getSendParam(Characteristic.HeatingThresholdTemperature, value);
            this.platform.tuyaOpenApi.sendCommand(this.deviceId, param)
              .then(() => {
                this.setCachedState(Characteristic.HeatingThresholdTemperature, value);
                callback();
              })
              .catch(err => {
                this.log.error('[SET][%s] HeatingThresholdTemperature Error: %s', this.homebridgeAccessory.displayName, err);
                this.invalidateCache();
                callback(err);
              });
          });
      }
      
    }
  }

  normalAsync(name, hbValue, props) {
    this.setCachedState(name, hbValue);
    if (this.isRefresh) {
      this.service.getCharacteristic(name).updateValue(hbValue);
    } else {
      this.getAccessoryCharacteristic(name, props);
    }
  }

  getAccessoryCharacteristic(name, props) {
    this.service.getCharacteristic(name)
      .setProps(props || {})
      .on('get', callback => {
        if (this.hasValidCache()) callback(null, this.getCachedState(name));
      })
      .on('set', (value, callback) => {
        if (name === Characteristic.TargetHeaterCoolerState || name === Characteristic.TemperatureDisplayUnits) {
          callback();
          return;
        }
        const param = this.getSendParam(name, value);
        this.platform.tuyaOpenApi.sendCommand(this.deviceId, param)
          .then(() => {
            this.setCachedState(name, value);
            callback();
          })
          .catch(error => {
            this.log.error('[SET][%s] Error: %s', this.homebridgeAccessory.displayName, error);
            this.invalidateCache();
            callback(error);
          });
      });
  }

  getSendParam(name, value) {
    let code;
    switch (name) {
      case Characteristic.Active:
        code = 'switch';
        value = !!value;
        break;
      case Characteristic.LockPhysicalControls:
        code = 'lock';
        value = !!value;
        break;
      case Characteristic.RotationSpeed:
        let level = Math.floor(value / this.speed_coefficient) + 1;
        level = Math.min(level, this.level_count);
        code = this.speedMap.code;
        value = "" + level;
        break;
      case Characteristic.TargetTemperature:
        code = this.tempsetMap.code;
        break;
      default:
        break;
    }
    return { commands: [{ code, value }] };
  }

  tuyaParamToHomeBridge(name, param) {
    switch (name) {
      case Characteristic.Active:
      case Characteristic.LockPhysicalControls:
      case Characteristic.SwingMode:
        return param.value ? 1 : 0;
      case Characteristic.TemperatureDisplayUnits:
        return param.code === 'water_temp' ? 0 : 1;
      case Characteristic.RotationSpeed:
        return parseInt(param.value * this.speed_coefficient);
      default:
        return param.value;
    }
  }

  getLevelFunction(code) {
    if (!this.functionArr.length) return DEFAULT_LEVEL_COUNT;
    const funcDic = this.functionArr.find(item => item.code === code);
    if (funcDic) {
      const value = JSON.parse(funcDic.values);
      const isNull = JSON.stringify(value) === "{}";
      return isNull ? DEFAULT_LEVEL_COUNT : value.range.length;
    }
    return DEFAULT_LEVEL_COUNT;
  }

  getTempSetDPRange() {
    if (!this.functionArr.length) return;
    let tempSetRange;
    for (const funcDic of this.functionArr) {
      const valueRange = JSON.parse(funcDic.values);
      const isNull = JSON.stringify(valueRange) === "{}";
      switch (funcDic.code) {
        case 'temp_set':
          tempSetRange = isNull ? { min: 30, max: 70 } : { min: parseInt(valueRange.min), max: parseInt(valueRange.max) };
          break;
        case 'temp_set_f':
          tempSetRange = isNull ? { min: 86, max: 158 } : { min: parseInt(valueRange.min), max: parseInt(valueRange.max) };
          break;
      }
    }
    return tempSetRange;
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

module.exports = HeaterAccessory;
