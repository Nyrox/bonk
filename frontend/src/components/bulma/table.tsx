import classNames from "classnames"
import React, { ReactNode } from "react"






export interface TableProps {
    hover?: boolean,
    fullwidth?: boolean,
    columns: (string | ReactNode)[],
    className?: string,
}

export const Table: React.FunctionComponent<TableProps> = ({
    hover = false,
    fullwidth = false,
    className = "",
    columns,
    children }) => {
    
    return <table className={classNames(className, "table", { "is-hoverable": hover, "is-fullwidth": fullwidth })}>
        <thead>
            <tr>
                { columns.map(c =>
                    typeof c == "string" ?
                        <td key={c}>{c}</td> :
                        { c } )}
            </tr>
        </thead>
        <tbody>
            { children }
        </tbody>
    </table>
}