import _ from "lodash"

//IDK why but without this pulumi fails to compile files using _.defaults
//Other lodash methods compile just fine.
declare module "lodash" {
    // noinspection JSUnusedGlobalSymbols
    interface LoDashStatic {
        defaults<TObject, TSource>(object: TObject, source: TSource): NonNullable<TSource & TObject>;

        defaults<TObject, TSource1, TSource2>(object: TObject, source1: TSource1, source2: TSource2): NonNullable<TSource2 & TSource1 & TObject>;

        defaults<TObject, TSource1, TSource2, TSource3>(object: TObject, source1: TSource1, source2: TSource2, source3: TSource3): NonNullable<TSource3 & TSource2 & TSource1 & TObject>;

        defaults<TObject, TSource1, TSource2, TSource3, TSource4>(object: TObject, source1: TSource1, source2: TSource2, source3: TSource3, source4: TSource4): NonNullable<TSource4 & TSource3 & TSource2 & TSource1 & TObject>;

        defaults<TObject>(object: TObject): NonNullable<TObject>;

        defaults(object: any, ...sources: any[]): any;
    }
}

declare module 'lodash' {
    interface LoDashStatic {
        throw(errorMessage: string, E?:{ new(m:string): Error ;}): never
    }
}

_.mixin({
    'throw': function(errorMessage: string, E?:{ new(m:string): Error ;}): never {
        throw new (E ?? Error)(errorMessage);
    }
})

export default _