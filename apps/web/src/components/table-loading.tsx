import { TableCell, TableRow } from "./ui/table";

export function TableLoading({ columns }: { columns: number }) {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <TableRow key={row} className="table-loading-row">
          {Array.from({ length: columns }, (_, column) => (
            <TableCell key={column}>
              {row === 0 && column === 0 && (
                <span className="sr-only" role="status">
                  Загрузка данных…
                </span>
              )}
              <span className="table-placeholder" aria-hidden />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
