// base implementation for devices with a TLV-based payload format
import HADevice from './base.js'

import crc16 from '../../util/crc16.js'
import * as TLV from "../../util/tlv.js";
import { Device as Thinq2Device } from "../thinq2/device.js"
import { type Config, type Connection } from '../homeassistant.js';
import log from '../../util/logging.js'

export type FieldDefinition = {
    id?: number;
    name: string;
    comp?: string;
    state_topic?: string;
    readable?: boolean;
    writable?: boolean;
    write_xform?: (val: string) => string|number|null|undefined,
    write_attach?: number[] | ((val: unknown) => number[]),
    read_xform?: (val: number) => string|number|undefined, // undefined return values are discarded
    read_callback?: (val: string|number) => boolean,
    write_callback?: (val: number) => boolean,
}

export default class TLVDevice extends HADevice {
    query_timer: ReturnType<typeof setInterval> | undefined
    fields_by_id: Record<number, FieldDefinition> = {}
    fields_by_ha: Record<string, FieldDefinition> = {}
    raw_clip_state: Record<number, number> = {}
    query_caps_timeout: ReturnType<typeof setInterval> | undefined = undefined

    constructor(HA: Connection, ha_class, readonly thinq: Thinq2Device) {
        super(HA, ha_class, thinq.id)
        thinq.on('data', (data) => this.processData(data))

	// initial capabilities query
	this.queryCaps()

	// retry every 15 s until caps are received
	this.query_caps_timeout = setInterval(() => {
		log('status', this.id, 're-trying capabilities query due to timeout')
		this.queryCaps()
	}, 15 * 1000);
    }

    // we waste memory by storing the field set per-device, not per-class. Whatever.
	addField(config: Config, options: FieldDefinition, autoreg?: boolean) {
		if(options.id)
			this.fields_by_id[options.id] = options

		let fullName: string = ''
		if (options.comp != null) {
			fullName = options.comp + '-' + options.name
		} else {
			fullName = options.name
		}
		if(options.comp || options.name) {
			this.fields_by_ha[fullName] = options
		}

		if(autoreg !== false) {
			let topicPrefix: string = ''
			if(options.name !== '') {
				topicPrefix = options.name + '_'
			}

			if (options.comp != null) {
				config = config['components'][options.comp]
			}

			if(options.readable !== false) {
				const stateTopic = options.state_topic == null ?
						   'state_topic' : options.state_topic
				config[topicPrefix + stateTopic] = '$this/' + fullName
			}

			if(options.writable !== false)
				config[topicPrefix + 'command_topic'] = '$this/' + fullName + '/set'
		}
	}

    // clip-side
    queryCaps() {
        this.send([1,1,2,2,1], [{t: 0x1f5, v: 1 }])
    }

    query() {
        this.send([1,1,2,2,1], [{t: 0x1f5, v: 2 }])
    }

    start() {
	this.query()

	// Refresh every 15 minutes since not every tag change generates async notify
	this.query_timer = setInterval(() => {
	    log('status', this.id, 'sending periodic refresh query')
	    this.query()
	}, 15 * 60 * 1000)
    }

    drop() {
	if(this.query_timer != undefined) {
	    clearInterval(this.query_timer)
	    this.query_timer = undefined
	}

	if(this.query_caps_timeout != undefined) {
	    clearInterval(this.query_caps_timeout)
	    this.query_caps_timeout = undefined
	}

	super.drop()
    }

    processData(buf: Buffer) {
        if(buf[2] == 0x04 && buf[3] == 0x00 && buf[4] == 0x00 && buf[5] == 0x00 && buf[6] == 0x87 && buf[7] == 0x02 && (buf[8] == 0x01 || buf[8] == 0x04)
            /* && buf[9] is a "sequence" number */ && buf[10] == buf.length-13) {

            // ignore the CRC, we assume that the modem verifies it :/
            log('status', this.id, 'received TLV packet')
            this.processTLV(TLV.parse(buf.subarray(11, buf.length-2)))
        }
	}

    send(header: number[], tlv: TLV.TLV[]) {
		const [b0, b1, b2, b3, b4] = header
		const tlvArray = TLV.build(tlv)
		let buf = [0x04, 0x00, 0x00, 0x00, 0x65, b2, b3, b4, tlvArray.length].concat(tlvArray)
		const result = crc16(buf)
		buf = [ b0, b1 ].concat(buf, [ result >> 8, result & 0xff])
        this.thinq.send_packet(Buffer.from(buf))
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* To be overridden */
        return false;
    }

    capabilityReceived() {
        /* To be overridden if necessary */
    }

    processTLV(tlvArray: TLV.TLV[]) {
        tlvArray.forEach(({t, v}) => this.processKeyValue(t, v))

        if(this.query_caps_timeout != undefined &&
            this.isCapsResponse(tlvArray)) {
            log('status', this.id, 'received capability key')
            clearInterval(this.query_caps_timeout)
            this.query_caps_timeout = undefined
            this.capabilityReceived()
        }
    }

    processKeyValue(k: number, v: number) {
        this.raw_clip_state[k] = v

        const def = this.fields_by_id[k]
        if(!def) 
            return

        let processed: string|number = v

        if(def.read_xform) {
            let tmp = def.read_xform(processed)
            if(tmp === undefined)
                return;
            processed = tmp
        }            

        var doRead = true
        if(def.read_callback)
            doRead = def.read_callback(processed)
        if(doRead) {
            if(def.readable === false)
                return

            let fullName: string = ''
            if (def.comp != null) {
                fullName = def.comp + '-' + def.name
            } else {
                fullName = def.name
            }

            this.HA.publishProperty(this.id, fullName, processed)
        }
    }

    // HA-side
    setProperty(prop: string, mqttValue: string) {
        //console.log("HA write", prop, mqttValue)
        const def = this.fields_by_ha[prop]
        if(!def || def.writable === false) {
            console.warn(`Attempting to set property ${prop} which is not writable`)
            return
        }

        let value: string|number|null|undefined
        if(def.write_xform)
            value = def.write_xform(mqttValue)

        if(value === null || value === undefined)
            return

        if(typeof(value) === 'string')
            value = Number(value)


        var doWrite = true
        if(def.write_callback)
            doWrite = def.write_callback(value)
        if(doWrite && def.id !== undefined) {
            this.raw_clip_state[def.id] = value

            let attach: number[] = []
            if(Array.isArray(def.write_attach))
                attach = def.write_attach
            if(typeof(def.write_attach) === 'function')
                attach = def.write_attach(value)

            const write_fields = [ def.id ].concat(attach)
            const tlvArray = write_fields.map((id) => ({ t: id, v: this.raw_clip_state[id] }))
            //console.log("Sending ", tlvArray)
            this.send([1, 1, 2, 1, 1], tlvArray)
        }
    }
}
