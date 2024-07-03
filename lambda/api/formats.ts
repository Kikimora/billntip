import {FormatRegistry, Type} from "@sinclair/typebox";
import xss from "xss";
import _ from "lodash";

/**
 * Pass input string through an XSS filter.
 */
export const HtmlString = Type.Transform(Type.String())
    //Convert String to Html String
    .Decode(xss)

export const registerDefaultFormats = _.once(function () {
        FormatRegistry.Set('uri', IsUrl)
        FormatRegistry.Set('date', IsDate)
        FormatRegistry.Set('time', IsTime)
        FormatRegistry.Set('date-time', IsDateTime)
        FormatRegistry.Set('uuid', IsUuid)
        FormatRegistry.Set('ipv6', IsIPv6)
        FormatRegistry.Set('ipv4', IsIPv4)
        FormatRegistry.Set('email', IsEmail)
    }
)


const Url =
    /^(?:https?|wss?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu

/**
 * A uniform resource locator as defined in [RFC 1738](https://www.rfc-editor.org/rfc/rfc1738)
 * @example `http://domain.com`
 */
export function IsUrl(value: string) {
    try {
        new URL(value);
        return true;
    } catch (error) {
        return false;
    }
}


const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/

function IsLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/**
 * `[ajv-formats]` ISO8601 Date component
 * @example `2020-12-12`
 */
export function IsDate(value: string): boolean {
    const matches: string[] | null = DATE.exec(value)
    if (!matches) return false
    const year: number = +matches[1]
    const month: number = +matches[2]
    const day: number = +matches[3]
    return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && IsLeapYear(year) ? 29 : DAYS[month])
}


const TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i

/**
 * `[ajv-formats]` ISO8601 Time component
 * @example `20:20:39+00:00`
 */
export function IsTime(value: string, strictTimeZone?: boolean): boolean {
    const matches: string[] | null = TIME.exec(value)
    if (!matches) return false
    const hr: number = +matches[1]
    const min: number = +matches[2]
    const sec: number = +matches[3]
    const tz: string | undefined = matches[4]
    const tzSign: number = matches[5] === '-' ? -1 : 1
    const tzH: number = +(matches[6] || 0)
    const tzM: number = +(matches[7] || 0)
    if (tzH > 23 || tzM > 59 || (strictTimeZone && !tz)) return false
    if (hr <= 23 && min <= 59 && sec < 60) return true
    const utcMin = min - tzM * tzSign
    const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0)
    return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61
}


const DATE_TIME_SEPARATOR = /t|\s/i

/**
 * `[ajv-formats]` ISO8601 DateTime
 * @example `2020-12-12T20:20:40+00:00`
 */
export function IsDateTime(value: string, strictTimeZone?: boolean): boolean {
    const dateTime: string[] = value.split(DATE_TIME_SEPARATOR)
    return dateTime.length === 2 && IsDate(dateTime[0]) && IsTime(dateTime[1], strictTimeZone)
}


const Uuid = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

/**
 * `[ajv-formats]` A Universally Unique Identifier as defined by [RFC 4122](https://datatracker.ietf.org/doc/html/rfc4122).
 * @example `9aa8a673-8590-4db2-9830-01755844f7c1`
 */
export function IsUuid(value: string): boolean {
    return Uuid.test(value)
}


const IPv6 =
    /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i

/**
 * `[ajv-formats]` IPv6 address as defined in [RFC 2373, section 2.2](http://tools.ietf.org/html/rfc2373#section-2.2).
 * @example `2001:0db8:85a3:0000:0000:8a2e:0370:7334`
 */
export function IsIPv6(value: string): boolean {
    return IPv6.test(value)
}


const IPv4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/**
 * `[ajv-formats]` IPv4 address according to dotted-quad ABNF syntax as defined in [RFC 2673, section 3.2](http://tools.ietf.org/html/rfc2673#section-3.2)
 * @example `192.168.0.1`
 */
export function IsIPv4(value: string): boolean {
    return IPv4.test(value)
}


const Email = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

/**
 * `[ajv-formats]` Internet Email Address [RFC 5321, section 4.1.2.](http://tools.ietf.org/html/rfc5321#section-4.1.2)
 * @example `user@domain.com`
 */
export function IsEmail(value: string): boolean {
    return Email.test(value)
}
