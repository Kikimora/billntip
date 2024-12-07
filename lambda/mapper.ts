import {
    CamelCasedPropertiesDeep, IsAny,
    PascalCasedPropertiesDeep,
    Paths,
    SnakeCasedPropertiesDeep,
    Split, UnionToIntersection
} from "type-fest";
import _ from "lodash";
import {toCamelCase, toPascalCase, toSnakeCase} from "@app/util";
import {map} from "@app/lambda/index";

/**
 * Bidirectional mapper from X to Y and vice versa.
 */
export interface Mapper<X = any, Y = any> {
    /**
     * Map from X to Y.
     * @param src source object of type X
     */
    mapDirect(src: X): Y

    /**
     * Map from Y to X
     * @param src source object of type Y
     */
    mapInverse(src: Y): X
}

type PathArray<T> = IsAny<T> extends true ? string[] : Paths<T> extends string ? Split<Paths<T>, '.'> : never;

type PropertyMapping<From, To> = [PathArray<From>, PathArray<To>, Mapper?]
/**
 * Collection of property mapping with optional mapper to map property value.
 * @example
 *     interface Source {
 *         OwnerName: string
 *         OwnerAddress: {
 *             AddressLines: string[] //max 2 lines
 *             Country: string
 *             PostalCode: string
 *             City?: string
 *         },
 *         Details: { Name: string, Value: string }[]
 *     }
 *
 *     interface Destination {
 *         owner: {
 *             name: string
 *             address_line1: string
 *             address_line2?: string
 *             zip: string
 *             city?: string
 *             country: string
 *         }
 *         metadata: { name: string, value: string }[]
 *     }
 *
 *     const detailsMapping: Mapping<Source['Details'][number], Destination['metadata'][number]> = [
 *         [['Name'], ['name']],
 *         [['Value'], ['value']],
 *     ]
 *
 *     const mapping: Mapping<Source, Destination> = [
 *         [['OwnerName'], ['owner', 'name']],
 *         [['OwnerAddress', 'AddressLines', '0'], ['owner', 'address_line1']],
 *         [['OwnerAddress', 'AddressLines', '1'], ['owner', 'address_line2']],
 *         [['OwnerAddress', 'PostalCode'], ['owner', 'zip']],
 *         [['OwnerAddress', 'Country'], ['owner', 'country']],
 *         [['OwnerAddress', 'City'], ['owner', 'city']],
 *         [['Details'], ['metadata'], arrayOfObject(detailsMapping)]
 *     ]
 *     const mapper = new ObjectMapper(mapping)
 */
export type Mapping<From = any, To = any> = PropertyMapping<From, To>[]

const mapper = function <X, Y>(direct: (x: X) => Y, inverse: (y: Y) => X) {
    return new GenericMapper(direct, inverse)
};
export default mapper
/**
 * Maps one array of objects to another.
 * @param mapping - mapping definition
 */
mapper.arrayOfObjects = function arrayOfObjects<X extends object, Y extends object>(mapping: Mapping<X, Y>) {
    return new ArrayMapper(new ObjectMapper(mapping))
}
/**
 * Maps one array to another using provided mapper.
 * @param mapper - array values mapper
 */
mapper.array = function array<X, Y>(mapper: Mapper<X, Y>) {
    return new ArrayMapper(mapper)
}
/**
 * Map object properties to each other using simple mapping description (see {@link Mapping} for details).
 * @param mapping - mapping definition
 */
mapper.object = function <X extends object, Y extends object>(mapping: Mapping<X, Y>) {
    return new ObjectMapper(mapping)
}

// mapper.object2 = function <X extends object, Y extends object>(mapping: Mapping<X, Y>) {
//     return new ObjectMapper2(mapping)
// }

type Mapping2<X, Y> = [X, Y, Mapper?][]
mapper.mapping = function <const M extends Mapping2<X, Y>, X, Y>(mapping: M) {
    return mapping
}
//
// const x = mapper.mapping([
//     [['DebitedFunds', 'Amount'], ['amount']],
//     [['DebitedFunds', 'Currency'], ['currency']],
//     [['CardId'], ['details', 'card']],
//     [['BrowserInfo', 'Language'], ['browser_info', 'language']],
//     [['BrowserInfo', 'AcceptHeader'], ['browser_info', 'accept_header']],
//     [['BrowserInfo', 'ColorDepth'], ['browser_info', 'color_depth']],
//     [['BrowserInfo', 'JavaEnabled'], ['browser_info', 'java']],
//     [['BrowserInfo', 'JavascriptEnabled'], ['browser_info', 'js']],
//     [['BrowserInfo', 'ScreenHeight'], ['browser_info', 'screen_height']],
//     [['BrowserInfo', 'ScreenWidth'], ['browser_info', 'screen_width']],
//     [['BrowserInfo', 'TimeZoneOffset'], ['browser_info', 'tz'], map(x => Number.parseInt(x), y => y.toString())],
//     [['BrowserInfo', 'UserAgent'], ['browser_info', 'user_agent']],
//     [['IpAddress'], ['ip_address']],
//     [['SecureModeReturnURL'], ['auth_return_url']]
// ])
// type A<M extends Mapping2<X, Y>, X, Y> = M[0]
// type XX = UnionToIntersection<typeof x[0]>
//

/**
 * Changes value property names from camelCase to snake_case and vice versa.
 */
mapper.camelToSnake = function <X, Y>() {
    return new CamelToSnakeObjectMapper<X, Y>()
}

/**
 * Changes value property names from PascalCase to snake_case and vice versa.
 */
mapper.pascalToSnake = function <X, Y>() {
    return new PascalToSnakeObjectMapper<X, Y>()
}

/**
 * Run two mappers one after another.
 * @param start - first mapper
 * @param finish - second mapper
 */
mapper.pipe = function <X, Y, Z>(start: Mapper<X, Y>, finish: Mapper<Y, Z>) {
    return new PipelineMapper(start, finish)
}

/**
 * Map records between each other converting keys and values using provided mappers.
 */
mapper.record = function <X, Y>(valueMapper: Mapper<X, Y>, keyMapper?: Mapper<string, string>) {
    return new RecordMapper(keyMapper ?? new IdentityMapper(), valueMapper)
}

export function isMapper(x: any): x is Mapper<any, any> {
    return x !== undefined && x !== null && 'mapDirect' in x && 'mapInverse' in x && x.mapDirect instanceof Function && x.mapInverse instanceof Function
}

/**
 * Map value to itself.
 */
export class IdentityMapper<X> implements Mapper<X, X> {
    mapDirect(src: X): X {
        return src
    }

    mapInverse(src: X): X {
        return src
    }
}

/**
 * Map one value to another using provided functions.
 */
export class GenericMapper<X, Y> implements Mapper<X, Y> {
    constructor(private direct: (x: X) => Y, private inverse: (y: Y) => X) {
    }

    mapDirect(src: X): Y {
        return this.direct(src)
    }

    mapInverse(src: Y): X {
        return this.inverse(src)
    }
}

/**
 * See {@link mapper.array}
 */
export class ArrayMapper<X, Y> implements Mapper<X[], Y[]> {

    constructor(public readonly mapper: Mapper<X, Y>) {
    }

    mapDirect(src: X[]): Y[] {
        const {mapper} = this
        return src.map(function (x) {
            return mapper.mapDirect(x)
        })
    }

    mapInverse(src: Y[]): X[] {
        const {mapper} = this
        return src.map(function (x) {
            return mapper.mapInverse(x)
        })
    }
}

/**
 * See {@link mapper.record}.
 */
export class RecordMapper<X, Y> implements Mapper<Record<string, X>, Record<string, Y>> {

    constructor(public readonly keyMapper: Mapper<string, string>,
                public readonly valueMapper: Mapper<X, Y>) {
    }

    mapDirect(src: Record<string, X>): Record<string, Y> {
        const {keyMapper, valueMapper} = this
        return _(src)
            .mapKeys(function (_, k) {
                return keyMapper.mapDirect(k)
            })
            .mapValues(function (v) {
                return valueMapper.mapDirect(v)
            })
            .value()
    }

    mapInverse(src: Record<string, Y>): Record<string, X> {
        const {keyMapper, valueMapper} = this
        return _(src)
            .mapKeys(function (_, k) {
                return keyMapper.mapInverse(k)
            })
            .mapValues(function (v) {
                return valueMapper.mapInverse(v)
            })
            .value()
    }
}

/**
 * See {@link mapper.pipe}
 */
export class PipelineMapper<X, Y, Z> implements Mapper<X, Z> {
    constructor(public readonly mapper1: Mapper<X, Y>,
                public readonly mapper2: Mapper<Y, Z>) {
    }

    mapDirect(src: X): Z {
        const {mapper1, mapper2} = this
        const y = mapper1.mapDirect(src)
        return mapper2.mapDirect(y)
    }

    mapInverse(src: Z): X {
        const {mapper1, mapper2} = this
        const y = mapper2.mapInverse(src)
        return mapper1.mapInverse(y)
    }
}

/**
 * See {@link mapper.camelToSnake}
 */
export class CamelToSnakeObjectMapper<X, Y> implements Mapper<CamelCasedPropertiesDeep<X>, SnakeCasedPropertiesDeep<Y>> {
    mapDirect(src: CamelCasedPropertiesDeep<X>): SnakeCasedPropertiesDeep<Y> {
        return toSnakeCase(src) as SnakeCasedPropertiesDeep<Y>
    }

    mapInverse(src: SnakeCasedPropertiesDeep<Y>): CamelCasedPropertiesDeep<X> {
        return toCamelCase(src) as CamelCasedPropertiesDeep<X>
    }
}

/**
 * See {@link mapper.pascalToSnake}
 */
export class PascalToSnakeObjectMapper<X, Y> implements Mapper<PascalCasedPropertiesDeep<X>, SnakeCasedPropertiesDeep<Y>> {
    mapDirect(src: PascalCasedPropertiesDeep<X>): SnakeCasedPropertiesDeep<Y> {
        return toSnakeCase(src) as SnakeCasedPropertiesDeep<Y>
    }

    mapInverse(src: SnakeCasedPropertiesDeep<Y>): PascalCasedPropertiesDeep<X> {
        return toPascalCase(src) as PascalCasedPropertiesDeep<X>
    }
}

/**
 * See {@link mapper.object}
 */
export class ObjectMapper<X extends object, Y extends object> implements Mapper<Partial<X>, Partial<Y>> {
    /**
     * Create mapper with a given mapping.
     * @param mapping mapping between properties
     */
    constructor(public readonly mapping: Mapping<X, Y>) {
    }

    mapDirect(src: Partial<X>): Partial<Y> {
        const dst: Partial<Y> = {}
        for (const [x, y, mapper] of this.mapping) {
            let value = _.get(src, x);
            if (value !== undefined) {
                if (isMapper(mapper)) {
                    value = mapper.mapDirect(value)
                }
                _.set(dst, y, value)
            }
        }
        return dst
    }

    mapInverse(src: Partial<Y>): Partial<X> {
        const dst: Partial<X> = {}
        for (const [x, y, mapper] of this.mapping) {
            let value = _.get(src, y);
            if (value !== undefined) {
                if (isMapper(mapper)) {
                    value = mapper.mapInverse(value)
                }
                _.set(dst, x, value)
            }
        }
        return dst
    }
}

//
// /**
//  * See {@link mapper.object2}
//  */
// export class ObjectMapper2<X, Y> implements Mapper<X, Y> {
//     /**
//      * Create mapper with a given mapping.
//      * @param mapping mapping between properties
//      */
//     constructor(public readonly mapping: Mapping2<X, Y>) {
//     }
//
//     mapDirect(src: X): Y {
//         const dst: Partial<Y> = {}
//         for (const [x, y, mapper] of this.mapping) {
//             let value = _.get(src, x);
//             if (value !== undefined) {
//                 if (isMapper(mapper)) {
//                     value = mapper.mapDirect(value)
//                 }
//                 _.set(dst, y, value)
//             }
//         }
//         return dst as Y
//     }
//
//     mapInverse(src: Y): X {
//         const dst: Partial<X> = {}
//         for (const [x, y, mapper] of this.mapping) {
//             let value = _.get(src, y);
//             if (value !== undefined) {
//                 if (isMapper(mapper)) {
//                     value = mapper.mapInverse(value)
//                 }
//                 _.set(dst, x, value)
//             }
//         }
//         return dst as X
//     }
// }
